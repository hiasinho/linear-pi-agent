import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  initTheme,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";
import { handleSdkEvent, ProgressReporter, redact } from "./progress.js";
import type { AgentSessionWebhook } from "./session-runner.js";

const MAX_LINEAR_BODY_CHARS = 8_000;

// Some installed pi extensions render background widgets even when pi is used
// through the SDK. Initialize the global theme so those non-interactive hooks
// do not crash the Linear service with "Theme not initialized".
initTheme(config.PI_THEME, false);

export type PiRunResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  outputText: string;
  summary: string;
};

type ManagedSession = {
  session: AgentSession;
  unsubscribe: () => void;
  reporterRef: { current: ProgressReporter };
};

const sdkSessions = new Map<string, ManagedSession>();

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const maybeText = (part as { text?: unknown }).text;
      return typeof maybeText === "string" ? [maybeText] : [];
    })
    .join("\n");
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  return textFromContent((message as { content?: unknown }).content);
}

function finalAssistantText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown } | undefined;
    if (message?.role !== "assistant") continue;
    const text = messageText(message).trim();
    if (text) return text;
  }
  return undefined;
}

function guidanceText(payload: AgentSessionWebhook): string {
  const rules = payload.guidance?.flatMap((rule) => rule.body ? [rule.body] : []) ?? [];
  if (!rules.length) return "";
  return `\n\nLinear guidance:\n${rules.map((rule) => `- ${rule}`).join("\n")}`;
}

export function buildPiPrompt(payload: AgentSessionWebhook): string {
  const issue = payload.agentSession?.issue;
  const promptContext = payload.promptContext ?? payload.agentSession?.promptContext;

  return [
    "You are running as Pi, a Linear custom agent powered by pi.",
    "Work directly in this repository with full control. Make code changes when appropriate.",
    "Do not expose secrets. Be concise in your final summary for Linear.",
    "",
    issue ? "Linear issue:" : "Linear session:",
    issue?.identifier ? `- Identifier: ${issue.identifier}` : undefined,
    issue?.title ? `- Title: ${issue.title}` : undefined,
    issue?.url ? `- URL: ${issue.url}` : undefined,
    issue?.description ? `- Description:\n${issue.description}` : undefined,
    promptContext ? `\nLinear prompt context:\n${promptContext}` : undefined,
    guidanceText(payload),
    "",
    "When finished, summarize what changed, tests/checks run, and any remaining follow-up.",
  ].filter(Boolean).join("\n");
}

export function buildPiFollowUpPrompt(payload: AgentSessionWebhook): string {
  const followUp = payload.agentActivity?.content?.body?.trim();
  if (followUp) {
    return [
      "Linear user follow-up:",
      followUp,
      "",
      "Continue from the existing session context. Be concise in your final summary for Linear.",
    ].join("\n");
  }

  const promptContext = payload.promptContext ?? payload.agentSession?.promptContext;
  if (promptContext) {
    return [
      "Linear follow-up context:",
      promptContext,
      "",
      "Continue from the existing session context. Be concise in your final summary for Linear.",
    ].join("\n");
  }

  return "Linear sent a follow-up event without message text. Continue from the existing session context and summarize any useful status.";
}

export function summarizePiResult(result: PiRunResult): string {
  const combined = [result.outputText.trim(), result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ""]
    .filter(Boolean)
    .join("\n\n");

  if (!combined) {
    return result.exitCode === 0 ? "pi finished successfully without output." : "pi failed without output.";
  }

  const safe = redact(combined);
  if (safe.length <= MAX_LINEAR_BODY_CHARS) return safe;
  return `${safe.slice(0, MAX_LINEAR_BODY_CHARS)}\n\n…output truncated…`;
}

async function getSdkSession(agentSessionId: string, reporter: ProgressReporter): Promise<ManagedSession> {
  const existing = sdkSessions.get(agentSessionId);
  if (existing) {
    existing.reporterRef.current = reporter;
    return existing;
  }

  const sessionDir = path.resolve(config.PI_SESSION_DIR);
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, `${agentSessionId}.jsonl`);
  const sessionManager = SessionManager.open(sessionFile, sessionDir, config.PI_WORKDIR);
  const { session } = await createAgentSession({ cwd: config.PI_WORKDIR, sessionManager });

  const reporterRef = { current: reporter };
  const unsubscribe = session.subscribe((event) => handleSdkEvent(event, reporterRef.current));
  await session.bindExtensions({});

  const managed = { session, unsubscribe, reporterRef };
  sdkSessions.set(agentSessionId, managed);
  return managed;
}

function disposeSdkSession(agentSessionId: string): void {
  const managed = sdkSessions.get(agentSessionId);
  if (!managed) return;
  managed.unsubscribe();
  managed.session.dispose();
  sdkSessions.delete(agentSessionId);
}

export async function runPi(payload: AgentSessionWebhook): Promise<PiRunResult> {
  if (config.PI_RUNNER === "cli") {
    throw new Error("CLI pi runner fallback was removed from this build path; set PI_RUNNER=sdk or restore the legacy runner.");
  }

  const agentSessionId = payload.agentSession?.id;
  if (!agentSessionId) throw new Error("agentSession.id is required to run pi");

  const prompt = payload.action === "prompted" ? buildPiFollowUpPrompt(payload) : buildPiPrompt(payload);
  const reporter = new ProgressReporter({ agentSessionId });
  const managed = await getSdkSession(agentSessionId, reporter);
  let finalText = "";
  const captureFinal = managed.session.subscribe((event) => {
    if (event.type === "agent_end") finalText = finalAssistantText(event.messages) ?? finalText;
    if (event.type === "turn_end") finalText = messageText(event.message).trim() || finalText;
  });

  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;

  try {
    reporter.startHeartbeat();
    await Promise.race([
      managed.session.prompt(prompt),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          timedOut = true;
          reject(new Error("pi timed out"));
        }, config.PI_TIMEOUT_MS);
        timeout.unref();
      }),
    ]);

    await reporter.flush();
    const result: PiRunResult = {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      outputText: finalText,
      summary: "",
    };
    result.summary = summarizePiResult(result);
    return result;
  } catch (error) {
    await reporter.flush();

    if (timedOut) {
      try {
        await managed.session.abort();
      } catch (abortError) {
        console.error("pi abort failed; disposing SDK session", {
          message: abortError instanceof Error ? abortError.message : String(abortError),
        });
        disposeSdkSession(agentSessionId);
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    const result: PiRunResult = {
      exitCode: timedOut ? null : 1,
      signal: null,
      timedOut,
      stdout: "",
      stderr: timedOut ? "" : message,
      outputText: finalText,
      summary: "",
    };
    result.summary = summarizePiResult(result);
    return result;
  } finally {
    reporter.clearToolRuns();
    reporter.stopHeartbeat();
    if (timeout) clearTimeout(timeout);
    captureFinal();
  }
}

export async function queuePiFollowUp(agentSessionId: string, prompt: string): Promise<boolean> {
  const managed = sdkSessions.get(agentSessionId);
  if (!managed?.session.isStreaming) return false;
  await managed.session.followUp(prompt);
  return true;
}

export async function abortPiSession(agentSessionId: string): Promise<boolean> {
  const managed = sdkSessions.get(agentSessionId);
  if (!managed?.session.isStreaming) return false;
  await managed.session.abort();
  return true;
}
