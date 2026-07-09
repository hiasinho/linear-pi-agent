import { performance } from "node:perf_hooks";
import { createAgentActivity } from "./linear.js";
import {
  abortPiSession,
  buildPiFollowUpPrompt,
  MAX_LINEAR_BODY_CHARS,
  queuePiFollowUp,
  runPi,
  type PiRunResult,
} from "./pi-runner.js";
import { formatElapsed } from "./progress.js";

type SessionState = {
  running: boolean;
  pendingPayload?: AgentSessionWebhook;
  lastStartedAtMs?: number;
};

export type AgentSessionWebhook = {
  action?: string;
  agentActivity?: {
    content?: {
      body?: string;
      type?: string;
    };
  };
  agentSession?: {
    id?: string;
    promptContext?: string;
    issue?: {
      identifier?: string;
      title?: string;
      url?: string;
      description?: string | null;
    } | null;
  };
  promptContext?: string;
  guidance?: Array<{ body?: string; origin?: unknown }>;
};

const sessions = new Map<string, SessionState>();

function issueLabel(payload: AgentSessionWebhook): string {
  const issue = payload.agentSession?.issue;
  return issue?.identifier ? `${issue.identifier}: ${issue.title ?? "Untitled"}` : "Linear agent session";
}

function isStopPayload(payload: AgentSessionWebhook): boolean {
  const action = payload.action?.toLowerCase();
  if (action && ["cancel", "canceled", "cancelled", "stop", "stopped", "abort", "aborted"].includes(action)) {
    return true;
  }

  const body = payload.agentActivity?.content?.body?.trim().toLowerCase();
  return body === "stop" || body === "stopped" || body === "cancel" || body === "cancelled" || body === "canceled";
}

function elapsedSince(startedAtMs?: number): number | undefined {
  if (startedAtMs === undefined) return undefined;
  return Math.max(0, Math.round(performance.now() - startedAtMs));
}

export function finalResponseBody(summary: string, elapsedMs: number): string {
  const footer = `\n\n_Run completed in ${formatElapsed(elapsedMs)}._`;
  if (summary.length + footer.length <= MAX_LINEAR_BODY_CHARS) return `${summary}${footer}`;

  const summaryLength = Math.max(0, MAX_LINEAR_BODY_CHARS - footer.length);
  return `${summary.slice(0, summaryLength)}${footer}`;
}

function finalErrorReason(result: PiRunResult): string {
  return result.timedOut
    ? `pi timed out after ${formatElapsed(result.elapsedMs)}`
    : `pi failed after ${formatElapsed(result.elapsedMs)}`;
}

export function finalErrorBody(result: PiRunResult): string {
  return `${finalErrorReason(result)}\n\n${result.summary}`;
}

export function stopActivityBody(aborted: boolean, elapsedMs?: number): string {
  if (!aborted) return "Stop requested; no active pi run was in progress.";
  return elapsedMs === undefined ? "Stopped by user." : `Stopped by user after ${formatElapsed(elapsedMs)}.`;
}

export function crashActivityBody(error: Error, elapsedMs?: number): string {
  const prefix = elapsedMs === undefined
    ? "Pi failed to start or run pi"
    : `Pi failed to start or run pi after ${formatElapsed(elapsedMs)}`;
  return `${prefix}: ${error.message}`;
}

export async function handleAgentSessionWebhook(payload: AgentSessionWebhook): Promise<void> {
  const agentSessionId = payload.agentSession?.id;
  if (!agentSessionId) {
    console.warn("agent session webhook missing agentSession.id");
    return;
  }

  const state = sessions.get(agentSessionId) ?? { running: false };
  sessions.set(agentSessionId, state);

  if (isStopPayload(payload)) {
    console.log("agent session stop requested", { agentSessionId, action: payload.action, running: state.running });
    const elapsedMs = elapsedSince(state.lastStartedAtMs);
    state.pendingPayload = undefined;
    state.running = false;
    state.lastStartedAtMs = undefined;
    const aborted = await abortPiSession(agentSessionId);
    await createAgentActivity(agentSessionId, {
      type: "error",
      body: stopActivityBody(aborted, elapsedMs),
    });
    return;
  }

  if (payload.action === "created") {
    startRun(agentSessionId, payload, state);
    return;
  }

  if (payload.action === "prompted") {
    if (state.running) {
      if (await queuePiFollowUp(agentSessionId, buildPiFollowUpPrompt(payload))) {
        await createAgentActivity(agentSessionId, {
          type: "thought",
          body: "Pi received your follow-up. It is queued in the active pi session.",
        });
      } else {
        state.pendingPayload = payload;
        await createAgentActivity(agentSessionId, {
          type: "thought",
          body: "Pi received your follow-up. It will run after the current pi task finishes.",
        });
      }
      return;
    }

    startRun(agentSessionId, payload, state);
  }
}

function startRun(agentSessionId: string, payload: AgentSessionWebhook, state: SessionState): void {
  if (state.running) {
    state.pendingPayload = payload;
    void createAgentActivity(agentSessionId, {
      type: "thought",
      body: "A Pi run is already active for this session; this request is queued.",
    }).catch((error: Error) => console.error("failed to create queued activity", { message: error.message }));
    return;
  }

  state.running = true;
  state.lastStartedAtMs = performance.now();

  void runSession(agentSessionId, payload, state).catch(async (error: Error) => {
    const elapsedMs = elapsedSince(state.lastStartedAtMs);
    state.running = false;
    state.lastStartedAtMs = undefined;
    console.error("pi run crashed", { agentSessionId, message: error.message });
    await createAgentActivity(agentSessionId, {
      type: "error",
      body: crashActivityBody(error, elapsedMs),
    }).catch((activityError: Error) => {
      console.error("failed to create pi crash activity", { message: activityError.message });
    });
  });
}

async function runSession(agentSessionId: string, payload: AgentSessionWebhook, state: SessionState): Promise<void> {
  console.log("pi run started", { agentSessionId });
  await createAgentActivity(agentSessionId, {
    type: "thought",
    body: `Pi received ${issueLabel(payload)} and started working.`,
  }).catch((error: Error) => {
    console.error("failed to create start activity", { agentSessionId, message: error.message });
  });

  const result = await runPi(payload);
  console.log("pi run finished", {
    agentSessionId,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    elapsedMs: result.elapsedMs,
  });

  if (result.exitCode === 0 && !result.timedOut) {
    await createAgentActivity(agentSessionId, {
      type: "response",
      body: finalResponseBody(result.summary, result.elapsedMs),
    });
    console.log("linear response activity posted", { agentSessionId });

  } else {
    const reason = finalErrorReason(result);
    await createAgentActivity(agentSessionId, {
      type: "error",
      body: finalErrorBody(result),
    });
    console.log("linear error activity posted", { agentSessionId, reason });
  }

  // Mark run state as not running once run attempt finishes.
  state.running = false;
  state.lastStartedAtMs = undefined;

  const pendingPayload = state.pendingPayload;
  if (pendingPayload) {
    state.pendingPayload = undefined;
    startRun(agentSessionId, pendingPayload, state);
  }
}
