import { createAgentActivity } from "./linear.js";
import { abortPiSession, buildPiFollowUpPrompt, queuePiFollowUp, runPi } from "./pi-runner.js";

type SessionState = {
  running: boolean;
  pendingPayload?: AgentSessionWebhook;
  lastStartedAt?: number;
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
    state.pendingPayload = undefined;
    state.running = false;
    const aborted = await abortPiSession(agentSessionId);
    await createAgentActivity(agentSessionId, {
      type: "error",
      body: aborted ? "Stopped by user." : "Stop requested; no active pi run was in progress.",
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
  state.lastStartedAt = Date.now();

  void runSession(agentSessionId, payload, state).catch(async (error: Error) => {
    state.running = false;
    console.error("pi run crashed", { agentSessionId, message: error.message });
    await createAgentActivity(agentSessionId, {
      type: "error",
      body: `Pi failed to start or run pi: ${error.message}`,
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
  console.log("pi run finished", { agentSessionId, exitCode: result.exitCode, timedOut: result.timedOut });

  if (result.exitCode === 0 && !result.timedOut) {
    await createAgentActivity(agentSessionId, {
      type: "response",
      body: result.summary,
    });
    console.log("linear response activity posted", { agentSessionId });

  } else {
    const reason = result.timedOut
      ? "pi timed out"
      : `pi exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`;
    await createAgentActivity(agentSessionId, {
      type: "error",
      body: `${reason}\n\n${result.summary}`,
    });
    console.log("linear error activity posted", { agentSessionId, reason });
  }

  // Mark run state as not running once run attempt finishes.
  state.running = false;

  const pendingPayload = state.pendingPayload;
  if (pendingPayload) {
    state.pendingPayload = undefined;
    startRun(agentSessionId, pendingPayload, state);
  }
}
