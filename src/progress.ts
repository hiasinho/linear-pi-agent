import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";
import { createAgentActivity, type AgentActivityContent } from "./linear.js";

const MAX_PROGRESS_CHARS = 220;

type ProgressUpdate = {
  type: "thought" | "action";
  body: string;
  action?: string;
  parameter?: string;
  dedupeKey?: string;
};

type ProgressReporterOptions = {
  agentSessionId: string;
  debounceMs?: number;
  heartbeatMs?: number;
  send?: (agentSessionId: string, content: AgentActivityContent) => Promise<unknown>;
  logger?: Pick<typeof console, "error">;
};

export function redact(text: string): string {
  return text
    .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|AUTH)[A-Z0-9_]*\s*[=:]\s*)\S+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]");
}

export function truncate(text: string, maxChars = MAX_PROGRESS_CHARS): string {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

export function summarizeToolArgs(toolName: string, args: unknown): string {
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

export class ProgressReporter {
  private pending?: ProgressUpdate;
  private timer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatStartedAt = 0;
  private lastSentAt = 0;
  private lastSentKey?: string;
  private readonly debounceMs: number;
  private readonly heartbeatMs: number;
  private readonly send: (agentSessionId: string, content: AgentActivityContent) => Promise<unknown>;
  private readonly logger: Pick<typeof console, "error">;

  constructor(private readonly options: ProgressReporterOptions) {
    this.debounceMs = options.debounceMs ?? config.PI_PROGRESS_DEBOUNCE_MS;
    this.heartbeatMs = options.heartbeatMs ?? config.PI_PROGRESS_HEARTBEAT_MS;
    this.send = options.send ?? createAgentActivity;
    this.logger = options.logger ?? console;
  }

  thought(body: string): void {
    this.queue({ type: "thought", body: truncate(body) });
  }

  action(action: string, parameter: string): void {
    const body = truncate(`${action}: ${parameter}`);
    this.queue({ type: "thought", body });
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatStartedAt = Date.now();
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private heartbeat(): void {
    if (this.pending) return;
    if (this.lastSentAt && Date.now() - this.lastSentAt < this.heartbeatMs) return;
    const elapsedMinutes = Math.max(1, Math.round((Date.now() - this.heartbeatStartedAt) / 60_000));
    this.queue({
      type: "thought",
      body: `Pi is still working (${elapsedMinutes} min).`,
      dedupeKey: `heartbeat:${elapsedMinutes}`,
    });
  }

  private queue(update: ProgressUpdate): void {
    const body = update.body.trim();
    if (!body) return;

    const next = { ...update, body, dedupeKey: update.dedupeKey ?? this.dedupeKey(update) };
    if (this.pending?.dedupeKey === next.dedupeKey) return;
    if (this.lastSentKey === next.dedupeKey) return;

    this.pending = next;
    const wait = Math.max(0, this.debounceMs - (Date.now() - this.lastSentAt));
    if (this.timer) return;
    this.timer = setTimeout(() => void this.flush(), wait);
    this.timer.unref();
  }

  private dedupeKey(update: ProgressUpdate): string {
    if (update.type === "action") return `action:${update.action ?? ""}:${update.parameter ?? update.body}`;
    return `thought:${update.body}`;
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const update = this.pending;
    this.pending = undefined;
    if (!update) return;

    try {
      if (update.type === "action") {
        await this.send(this.options.agentSessionId, {
          type: "action",
          action: update.action ?? "Processing",
          parameter: update.parameter ?? update.body,
        });
      } else {
        await this.send(this.options.agentSessionId, { type: "thought", body: update.body });
      }
      this.lastSentAt = Date.now();
      this.lastSentKey = update.dedupeKey;
    } catch (error) {
      this.logger.error("failed to post pi progress", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function handleSdkEvent(event: AgentSessionEvent, reporter: ProgressReporter): void {
  switch (event.type) {
    case "agent_start":
      reporter.thought("Pi is starting the coding session.");
      break;
    case "turn_start":
      break;
    case "tool_execution_start":
      reporter.action(`Running ${event.toolName}`, summarizeToolArgs(event.toolName, event.args));
      break;
    case "tool_execution_end":
      if (event.isError) reporter.thought(`${event.toolName} reported an error; Pi is adjusting.`);
      break;
    case "message_end":
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
