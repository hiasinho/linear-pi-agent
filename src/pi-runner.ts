import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  initTheme,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";
import { createAgentActivity } from "./linear.js";
import type { AgentSessionWebhook } from "./session-runner.js";

const MAX_LINEAR_BODY_CHARS = 8_000;
const MAX_PROGRESS_CHARS = 220;

// Some installed pi extensions render background widgets even when pi is used
// through the SDK. Initialize the global theme so those non-interactive hooks
// do not crash the Linear service with "Theme not initialized".
initTheme(process.env.PI_THEME ?? "light", false);

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

function redact(text: string): string {
  return text
    .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH)[A-Z0-9_]*\s*[=:]\s*)\S+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]");
}

function truncate(text: string, maxChars = MAX_PROGRESS_CHARS): string {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

function summarizeToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return toolName;
  const record = args as Record<string, unknown>;
  const pathValue = record.path ?? record.file_path ?? record.filePath;
  if (typeof pathValue === "string") return `${toolName} ${pathValue}`;
  const command = record.command ?? record.cmd;
  if (typeof command === "string") return `${toolName} ${command}`;
  const query = record.query;
  if (typeof query === "string") return `${toolName} ${query}`;
  return toolName;
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

class ProgressReporter {
  private pending?: { type: "thought" | "action"; body: string; action?: string; parameter?: string };
  private timer?: NodeJS.Timeout;
  private lastSentAt = 0;

  constructor(private readonly agentSessionId: string) {}

  thought(body: string): void {
    this.queue({ type: "thought", body: truncate(body) });
  }

  action(action: string, parameter: string): void {
    // Keep tool/progress updates visible without leaving action-type entries
    // that may be interpreted by Linear as still-active work state.
    this.queue({
      type: "thought",
      body: `${action}: ${parameter}`.trim(),
    });
  }

  private queue(update: { type: "thought" | "action"; body: string; action?: string; parameter?: string }): void {
    this.pending = update;
    const wait = Math.max(0, config.PI_PROGRESS_DEBOUNCE_MS - (Date.now() - this.lastSentAt));
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), wait);
    this.timer.unref();
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const update = this.pending;
    this.pending = undefined;
    if (!update) return;
    this.lastSentAt = Date.now();
    try {
      if (update.type === "action") {
        await createAgentActivity(this.agentSessionId, {
          type: "action",
          action: update.action ?? "Processing",
          parameter: update.parameter ?? update.body,
        });
      } else {
        await createAgentActivity(this.agentSessionId, { type: "thought", body: update.body });
      }
    } catch (error) {
      console.error("failed to post pi progress", { message: error instanceof Error ? error.message : String(error) });
    }
  }
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

function handleSdkEvent(event: AgentSessionEvent, reporter: ProgressReporter): void {
  switch (event.type) {
    case "agent_start":
      reporter.thought("Pi is starting the coding session.");
      break;
    case "turn_start":
      reporter.thought("Pi is thinking.");
      break;
    case "tool_execution_start":
      reporter.action(`Running ${event.toolName}`, summarizeToolArgs(event.toolName, event.args));
      break;
    case "tool_execution_end":
      if (event.isError) reporter.thought(`${event.toolName} reported an error; Pi is adjusting.`);
      break;
    case "message_end":
      // Do not mirror assistant messages as progress thoughts. Linear uses the
      // latest activity to infer session state; duplicating the final answer as
      // a thought after the response can move a completed session back to active.
      break;
    case "compaction_start":
      reporter.thought("Pi is compacting context before continuing.");
      break;
    case "auto_retry_start":
      reporter.thought(`Pi is retrying after an error (${event.attempt}/${event.maxAttempts}).`);
      break;
    case "queue_update":
      break;
  }
}

export async function runPi(payload: AgentSessionWebhook): Promise<PiRunResult> {
  if (config.PI_RUNNER === "cli") {
    throw new Error("CLI pi runner fallback was removed from this build path; set PI_RUNNER=sdk or restore the legacy runner.");
  }

  const agentSessionId = payload.agentSession?.id;
  if (!agentSessionId) throw new Error("agentSession.id is required to run pi");

  const prompt = payload.action === "prompted" ? buildPiFollowUpPrompt(payload) : buildPiPrompt(payload);
  const reporter = new ProgressReporter(agentSessionId);
  const managed = await getSdkSession(agentSessionId, reporter);
  let finalText = "";
  const captureFinal = managed.session.subscribe((event) => {
    if (event.type === "agent_end") finalText = finalAssistantText(event.messages) ?? finalText;
    if (event.type === "turn_end") finalText = messageText(event.message).trim() || finalText;
  });

  let timedOut = false;
  let timeout: NodeJS.Timeout | undefined;

  try {
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
