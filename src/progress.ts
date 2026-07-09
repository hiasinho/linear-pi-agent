import { performance } from "node:perf_hooks";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { config } from "./config.js";
import { createAgentActivity, type AgentActivityContent } from "./linear.js";

const MAX_PROGRESS_CHARS = 220;

const SAFE_FALLBACK_FIELDS = ["path", "file_path", "filePath", "query", "pattern", "glob", "url", "name", "title"];

type ProgressUpdate = {
  type: "thought" | "action";
  body: string;
  action?: string;
  parameter?: string;
  dedupeKey?: string;
};

type ToolRun = {
  toolName: string;
  display: string;
  startedAtMs: number;
};

type ProgressReporterOptions = {
  agentSessionId: string;
  debounceMs?: number;
  heartbeatMs?: number;
  longToolMs?: number;
  nowMs?: () => number;
  send?: (agentSessionId: string, content: AgentActivityContent) => Promise<unknown>;
  logger?: Pick<typeof console, "error">;
};

function isSensitiveName(name: string): boolean {
  const normalized = name.replace(/[-_]/g, "").toLowerCase();
  return normalized === "key"
    || normalized === "apikey"
    || normalized.endsWith("apikey")
    || normalized === "pass"
    || normalized.includes("token")
    || normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("auth");
}

function sanitizeUrlText(text: string): string {
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveName(key)) url.searchParams.set(key, "redacted");
    }
    return url.toString();
  } catch {
    return text;
  }
}

function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => sanitizeUrlText(url));
}

export function redact(text: string): string {
  return redactUrls(text)
    .replace(/Authorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer [redacted]")
    .replace(/(--(?:token|api-key|apikey|key|secret|password|pass|auth)(?:\s+|=))\S+/gi, "$1[redacted]")
    .replace(/(^|[\s"'`])([A-Z0-9_.-]+)\s*([=:])\s*(\S+)/gi, (match, prefix: string, name: string, separator: string) => {
      if (name.toLowerCase() === "authorization") return match;
      return isSensitiveName(name) ? `${prefix}${name}${separator}[redacted]` : match;
    })
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[redacted]")
    .replace(/ghp_[A-Za-z0-9]{20,}/g, "ghp_[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-[redacted]");
}

export function truncate(text: string, maxChars = MAX_PROGRESS_CHARS): string {
  const clean = redact(text).replace(/\s+/g, " ").trim();
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const clean = value.replace(/\s+/g, " ").trim();
    return clean || undefined;
  }
  if (!Array.isArray(value)) return undefined;
  for (const item of value) {
    const clean = firstString(item);
    if (clean) return clean;
  }
  return undefined;
}

function summarizeString(value: unknown): string | undefined {
  const clean = firstString(value);
  return clean ? truncate(clean) : undefined;
}

function summarizeSearch(pattern: unknown, scope: unknown): string | undefined {
  const safePattern = summarizeString(pattern);
  const safeScope = summarizeString(scope);
  if (safePattern && safeScope) return `${safePattern} in ${safeScope}`;
  return safePattern ?? (safeScope ? `in ${safeScope}` : undefined);
}

function summarizeUrl(value: unknown): string | undefined {
  const clean = firstString(value);
  return clean ? truncate(sanitizeUrlText(clean)) : undefined;
}

function summarizeToolTarget(toolName: string, args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;

  switch (toolName.toLowerCase()) {
    case "bash":
      return summarizeString(record.command ?? record.cmd);
    case "read":
    case "write":
    case "edit":
      return summarizeString(record.path ?? record.file_path ?? record.filePath);
    case "ls":
      return summarizeString(record.path) ?? ".";
    case "grep":
    case "rg":
      return summarizeSearch(record.pattern ?? record.query ?? record.regex, record.path ?? record.glob);
    case "find":
      return summarizeSearch(record.pattern ?? record.query ?? record.name, record.path);
    case "search":
    case "web_search":
      return summarizeString(record.query ?? record.queries);
    case "fetch_content":
      return summarizeUrl(record.url ?? record.urls);
  }

  for (const field of SAFE_FALLBACK_FIELDS) {
    const summary = field === "url" ? summarizeUrl(record[field]) : summarizeString(record[field]);
    if (summary) return summary;
  }
  return undefined;
}

export function toolDisplayText(toolName: string, args: unknown): string {
  const safeToolName = truncate(toolName, 80);
  const detail = summarizeToolTarget(toolName, args);
  return truncate(detail ? `${safeToolName}: ${detail}` : safeToolName);
}

export function toolProgressText(toolName: string, args: unknown): string {
  return truncate(`Running ${toolDisplayText(toolName, args)}`);
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (!minutes) return `${seconds}s`;
  if (!remainingSeconds) return `${minutes}m`;
  return `${minutes}m ${remainingSeconds}s`;
}

export function toolCompletionText(display: string, elapsedMs: number): string {
  const suffix = ` after ${formatElapsed(elapsedMs)}.`;
  const prefix = "Finished ";
  const maxDisplayChars = MAX_PROGRESS_CHARS - prefix.length - suffix.length;
  const safeDisplay = truncate(display, Math.max(1, maxDisplayChars));
  return truncate(`${prefix}${safeDisplay}${suffix}`);
}

export class ProgressReporter {
  private pending?: ProgressUpdate;
  private timer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatStartedAt = 0;
  private lastSentAt = 0;
  private lastSentKey?: string;
  private toolRuns = new Map<string, ToolRun>();
  private readonly debounceMs: number;
  private readonly heartbeatMs: number;
  private readonly longToolMs: number;
  private readonly nowMs: () => number;
  private readonly send: (agentSessionId: string, content: AgentActivityContent) => Promise<unknown>;
  private readonly logger: Pick<typeof console, "error">;

  constructor(private readonly options: ProgressReporterOptions) {
    this.debounceMs = options.debounceMs ?? config.PI_PROGRESS_DEBOUNCE_MS;
    this.heartbeatMs = options.heartbeatMs ?? config.PI_PROGRESS_HEARTBEAT_MS;
    this.longToolMs = options.longToolMs ?? config.PI_PROGRESS_LONG_TOOL_MS;
    this.nowMs = options.nowMs ?? (() => performance.now());
    this.send = options.send ?? createAgentActivity;
    this.logger = options.logger ?? console;
  }

  thought(body: string): void {
    this.queue({ type: "thought", body: truncate(body) });
  }

  action(action: string, parameter: string): void {
    const body = parameter.trim() ? `${action}: ${parameter}` : action;
    this.queue({ type: "thought", body: truncate(body) });
  }

  toolStarted(toolCallId: string, toolName: string, args: unknown): void {
    const display = toolDisplayText(toolName, args);
    this.toolRuns.set(toolCallId, { toolName, display, startedAtMs: this.nowMs() });
    this.queue({ type: "thought", body: `Running ${display}`, dedupeKey: `tool-start:${toolCallId}` });
  }

  toolEnded(toolCallId: string, toolName: string, isError: boolean): void {
    const run = this.toolRuns.get(toolCallId);
    this.toolRuns.delete(toolCallId);

    if (isError) {
      this.queue({
        type: "thought",
        body: `${toolName} reported an error; Pi is adjusting.`,
        dedupeKey: `tool-error:${toolCallId}`,
      });
      return;
    }

    if (!run || this.longToolMs === 0) return;
    const elapsedMs = this.nowMs() - run.startedAtMs;
    if (elapsedMs < this.longToolMs) return;

    this.queue({
      type: "thought",
      body: toolCompletionText(run.display, elapsedMs),
      dedupeKey: `tool-complete:${toolCallId}`,
    });
  }

  clearToolRuns(): void {
    this.toolRuns.clear();
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
      reporter.toolStarted(event.toolCallId, event.toolName, event.args);
      break;
    case "tool_execution_update":
      break;
    case "tool_execution_end":
      reporter.toolEnded(event.toolCallId, event.toolName, event.isError);
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
