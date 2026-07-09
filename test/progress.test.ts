import assert from "node:assert/strict";
import { afterEach, before, test } from "node:test";
import type { AgentActivityContent } from "../src/linear.js";

before(() => {
  process.env.LINEAR_CLIENT_ID = "client";
  process.env.LINEAR_CLIENT_SECRET = "secret";
  process.env.LINEAR_WEBHOOK_SECRET = "webhook";
  process.env.LINEAR_REDIRECT_URI = "https://example.com/linear/oauth/callback";
  process.env.BASE_URL = "https://example.com";
  process.env.PI_WORKDIR = "/tmp";
});

afterEach(() => {
  delete process.env.PI_PROGRESS_DEBOUNCE_MS;
  delete process.env.PI_PROGRESS_HEARTBEAT_MS;
  delete process.env.PI_PROGRESS_LONG_TOOL_MS;
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function progressModule() {
  return import("../src/progress.js");
}

function sentCollector(fail = false) {
  const sent: AgentActivityContent[] = [];
  return {
    sent,
    send: async (_agentSessionId: string, content: AgentActivityContent) => {
      if (fail) throw new Error("send failed");
      sent.push(content);
    },
  };
}

test("duplicate pending progress is dropped", async () => {
  const { ProgressReporter } = await progressModule();
  const { sent, send } = sentCollector();
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 10_000, send });

  reporter.thought("same");
  reporter.thought("same");
  await reporter.flush();

  assert.deepEqual(sent, [{ type: "thought", body: "same" }]);
});

test("duplicate already-sent progress is dropped", async () => {
  const { ProgressReporter } = await progressModule();
  const { sent, send } = sentCollector();
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 1, send });

  reporter.thought("same");
  await reporter.flush();
  reporter.thought("same");
  await reporter.flush();

  assert.equal(sent.length, 1);
});

test("failed sends do not update dedupe state", async () => {
  const { ProgressReporter } = await progressModule();
  const sent: AgentActivityContent[] = [];
  let shouldFail = true;
  const reporter = new ProgressReporter({
    agentSessionId: "session",
    debounceMs: 1,
    logger: { error: () => undefined },
    send: async (_agentSessionId, content) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("send failed");
      }
      sent.push(content);
    },
  });

  reporter.thought("retry me");
  await reporter.flush();
  reporter.thought("retry me");
  await reporter.flush();

  assert.deepEqual(sent, [{ type: "thought", body: "retry me" }]);
});

test("turn_start and message_end create no progress", async () => {
  const { ProgressReporter, handleSdkEvent } = await progressModule();
  const { sent, send } = sentCollector();
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 1, send });

  handleSdkEvent({ type: "turn_start" } as never, reporter);
  handleSdkEvent({ type: "message_end" } as never, reporter);
  await reporter.flush();

  assert.equal(sent.length, 0);
});

test("toolProgressText formats known tools safely", async () => {
  const { toolProgressText } = await progressModule();

  assert.equal(toolProgressText("bash", { command: "npm run typecheck" }), "Running bash: npm run typecheck");
  assert.equal(toolProgressText("read", { path: "src/pi-runner.ts" }), "Running read: src/pi-runner.ts");
  assert.equal(toolProgressText("write", { path: "README.md", content: "SECRET=abc" }), "Running write: README.md");
  assert.equal(toolProgressText("edit", { path: "src/config.ts", oldText: "TOKEN=abc", newText: "TOKEN=def" }), "Running edit: src/config.ts");
  assert.equal(toolProgressText("ls", {}), "Running ls: .");
  assert.equal(toolProgressText("ls", { path: "src" }), "Running ls: src");
  assert.equal(toolProgressText("grep", { pattern: "ProgressReporter", path: "src" }), "Running grep: ProgressReporter in src");
  assert.equal(toolProgressText("rg", { query: "ProgressReporter", glob: "src/**/*.ts" }), "Running rg: ProgressReporter in src/**/*.ts");
  assert.equal(toolProgressText("find", { pattern: "*.ts", path: "src" }), "Running find: *.ts in src");
  assert.equal(toolProgressText("web_search", { query: "Linear agent progress API" }), "Running web_search: Linear agent progress API");
  assert.equal(toolProgressText("web_search", { queries: ["Linear agent progress API"] }), "Running web_search: Linear agent progress API");
  assert.equal(toolProgressText("fetch_content", { url: "https://linear.app/developers/agent-interaction" }), "Running fetch_content: https://linear.app/developers/agent-interaction");
  assert.equal(toolProgressText("fetch_content", { urls: ["https://example.com/a?token=abc"] }), "Running fetch_content: https://example.com/a?token=redacted");
});

test("toolProgressText does not leak write or edit content", async () => {
  const { toolProgressText } = await progressModule();

  const writeText = toolProgressText("write", { path: "README.md", content: "private content" });
  const editText = toolProgressText("edit", { path: "src/config.ts", edits: [{ oldText: "old secret", newText: "new secret" }] });

  assert.equal(writeText, "Running write: README.md");
  assert.equal(editText, "Running edit: src/config.ts");
  assert.equal(writeText.includes("private content"), false);
  assert.equal(editText.includes("old secret"), false);
  assert.equal(editText.includes("new secret"), false);
});

test("toolProgressText handles unknown tools with safe allowlisted fields only", async () => {
  const { toolProgressText } = await progressModule();

  assert.equal(toolProgressText("custom_tool", { path: "src/file.ts" }), "Running custom_tool: src/file.ts");
  assert.equal(toolProgressText("custom_tool", { token: "secret", content: "private" }), "Running custom_tool");
});

test("toolProgressText redacts tokens, auth headers, GitHub tokens, CLI flags, and URLs", async () => {
  const { toolProgressText } = await progressModule();

  const text = toolProgressText("bash", {
    command: "curl -H 'Authorization: Bearer abcdefghijklmnop' --token ghp_123456789012345678901234567890123456 https://user:pass@example.com/path?access_token=abc&ok=1 OPENAI_API_KEY=sk-12345678901234567890 github_pat_1234567890abcdefghijklmnopqrstuvwxyz",
  });

  assert.match(text, /Authorization: Bearer \[redacted\]/);
  assert.match(text, /--token \[redacted\]/);
  assert.match(text, /OPENAI_API_KEY=\[redacted\]/);
  assert.equal(text.includes("abcdefghijklmnop"), false);
  assert.equal(text.includes("ghp_123456"), false);
  assert.equal(text.includes("github_pat_123456"), false);
  assert.equal(text.includes("user:pass"), false);
  assert.equal(text.includes("access_token=abc"), false);
});

test("toolProgressText truncates long commands", async () => {
  const { toolProgressText } = await progressModule();

  const text = toolProgressText("bash", { command: "x".repeat(500) });

  assert.equal(text.length, 220);
  assert.equal(text.endsWith("…"), true);
});

test("formatElapsed returns compact elapsed time", async () => {
  const { formatElapsed } = await progressModule();

  assert.equal(formatElapsed(500), "1s");
  assert.equal(formatElapsed(30_000), "30s");
  assert.equal(formatElapsed(60_000), "1m");
  assert.equal(formatElapsed(74_000), "1m 14s");
});

test("fast successful tools do not report completion", async () => {
  const { ProgressReporter } = await progressModule();
  const { sent, send } = sentCollector();
  let now = 1_000;
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 1, longToolMs: 30_000, nowMs: () => now, send });

  reporter.toolStarted("call-1", "bash", { command: "npm test" });
  await reporter.flush();
  now += 29_000;
  reporter.toolEnded("call-1", "bash", false);
  await reporter.flush();

  assert.deepEqual(sent, [{ type: "thought", body: "Running bash: npm test" }]);
});

test("slow successful tools report completion at and above threshold", async () => {
  const { ProgressReporter } = await progressModule();
  const { sent, send } = sentCollector();
  let now = 0;
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 1, longToolMs: 30_000, nowMs: () => now, send });

  reporter.toolStarted("call-1", "bash", { command: "npm test" });
  await reporter.flush();
  now = 30_000;
  reporter.toolEnded("call-1", "bash", false);
  await reporter.flush();
  reporter.toolStarted("call-2", "bash", { command: "npm run build" });
  await reporter.flush();
  now = 104_000;
  reporter.toolEnded("call-2", "bash", false);
  await reporter.flush();

  assert.deepEqual(sent, [
    { type: "thought", body: "Running bash: npm test" },
    { type: "thought", body: "Finished bash: npm test after 30s." },
    { type: "thought", body: "Running bash: npm run build" },
    { type: "thought", body: "Finished bash: npm run build after 1m 14s." },
  ]);
});

test("long tool completion can be disabled", async () => {
  const { ProgressReporter } = await progressModule();
  const { sent, send } = sentCollector();
  let now = 0;
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 1, longToolMs: 0, nowMs: () => now, send });

  reporter.toolStarted("call-1", "bash", { command: "npm test" });
  await reporter.flush();
  now = 60_000;
  reporter.toolEnded("call-1", "bash", false);
  await reporter.flush();

  assert.deepEqual(sent, [{ type: "thought", body: "Running bash: npm test" }]);
});

test("failed tools still report an adjustment message", async () => {
  const { ProgressReporter } = await progressModule();
  const { sent, send } = sentCollector();
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 1, longToolMs: 30_000, send });

  reporter.toolStarted("call-1", "bash", { command: "npm test" });
  await reporter.flush();
  reporter.toolEnded("call-1", "bash", true);
  await reporter.flush();

  assert.deepEqual(sent, [
    { type: "thought", body: "Running bash: npm test" },
    { type: "thought", body: "bash reported an error; Pi is adjusting." },
  ]);
});

test("parallel same-name tools are tracked by toolCallId", async () => {
  const { ProgressReporter } = await progressModule();
  const { sent, send } = sentCollector();
  let now = 0;
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 1, longToolMs: 30_000, nowMs: () => now, send });

  reporter.toolStarted("call-1", "bash", { command: "npm test" });
  await reporter.flush();
  reporter.toolStarted("call-2", "bash", { command: "npm run build" });
  await reporter.flush();
  now = 31_000;
  reporter.toolEnded("call-2", "bash", false);
  await reporter.flush();
  now = 62_000;
  reporter.toolEnded("call-1", "bash", false);
  await reporter.flush();

  assert.deepEqual(sent, [
    { type: "thought", body: "Running bash: npm test" },
    { type: "thought", body: "Running bash: npm run build" },
    { type: "thought", body: "Finished bash: npm run build after 31s." },
    { type: "thought", body: "Finished bash: npm test after 1m 2s." },
  ]);
});

test("missing or cleared tool runs do not report successful completion", async () => {
  const { ProgressReporter } = await progressModule();
  const { sent, send } = sentCollector();
  let now = 0;
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 1, longToolMs: 30_000, nowMs: () => now, send });

  reporter.toolEnded("missing", "bash", false);
  reporter.toolStarted("call-1", "bash", { command: "npm test" });
  await reporter.flush();
  reporter.clearToolRuns();
  now = 60_000;
  reporter.toolEnded("call-1", "bash", false);
  await reporter.flush();

  assert.deepEqual(sent, [{ type: "thought", body: "Running bash: npm test" }]);
});

test("completion uses redacted truncated start display and ignores result", async () => {
  const { ProgressReporter } = await progressModule();
  const { sent, send } = sentCollector();
  let now = 0;
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 1, longToolMs: 30_000, nowMs: () => now, send });

  reporter.toolStarted("call-1", "bash", { command: `echo TOKEN=abc ${"x".repeat(500)}` });
  await reporter.flush();
  now = 30_000;
  reporter.toolEnded("call-1", "bash", false);
  await reporter.flush();

  const completion = sent[1]?.type === "thought" ? sent[1].body : "";
  assert.match(completion, /^Finished bash: echo TOKEN=\[redacted\]/);
  assert.match(completion, / after 30s\.$/);
  assert.equal(completion.includes("abc"), false);
  assert.equal(completion.includes("result"), false);
  assert.equal(completion.length <= 220, true);
});

test("tool_execution_start reports sanitized useful progress", async () => {
  const { ProgressReporter, handleSdkEvent } = await progressModule();
  const { sent, send } = sentCollector();
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 1, send });

  handleSdkEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "echo TOKEN=abc123" } } as never, reporter);
  await reporter.flush();

  assert.deepEqual(sent, [{ type: "thought", body: "Running bash: echo TOKEN=[redacted]" }]);
});

test("tool_execution_end reports slow completion and tool_execution_update is a no-op", async () => {
  const { ProgressReporter, handleSdkEvent } = await progressModule();
  const { sent, send } = sentCollector();
  let now = 0;
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 1, longToolMs: 30_000, nowMs: () => now, send });

  handleSdkEvent({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "npm test" } } as never, reporter);
  await reporter.flush();
  handleSdkEvent({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", args: {}, partialResult: "secret result" } as never, reporter);
  await reporter.flush();
  now = 31_000;
  handleSdkEvent({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", result: "secret result", isError: false } as never, reporter);
  handleSdkEvent({ type: "message_end" } as never, reporter);
  await reporter.flush();

  assert.deepEqual(sent, [
    { type: "thought", body: "Running bash: npm test" },
    { type: "thought", body: "Finished bash: npm test after 31s." },
  ]);
});

test("action redacts and truncates progress", async () => {
  const { ProgressReporter } = await progressModule();
  const { sent, send } = sentCollector();
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 1, send });

  reporter.action("Running bash", `Bearer abcdefghijklmnopqrstuvwxyz ${"x".repeat(300)}`);
  await reporter.flush();

  const body = sent[0]?.type === "thought" ? sent[0].body : "";
  assert.match(body, /Bearer \[redacted\]/);
  assert.equal(body.includes("abcdefghijklmnopqrstuvwxyz"), false);
  assert.equal(body.length, 220);
});

test("heartbeat sends after quiet interval and skips when pending exists", async () => {
  const { ProgressReporter } = await progressModule();
  const { sent, send } = sentCollector();
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 10_000, heartbeatMs: 20, send });

  reporter.thought("initial update");
  await reporter.flush();

  reporter.startHeartbeat();
  reporter.thought("specific update");
  await sleep(30);
  assert.equal(sent.length, 1);

  await reporter.flush();
  await sleep(25);
  assert.equal(sent.length, 2);

  await sleep(25);
  await reporter.flush();
  reporter.stopHeartbeat();

  assert.equal(sent.length, 3);
  assert.equal(sent[2]?.type, "thought");
  assert.match(sent[2]?.type === "thought" ? sent[2].body : "", /Pi is still working/);
});

test("stopHeartbeat prevents later heartbeat posts", async () => {
  const { ProgressReporter } = await progressModule();
  const { sent, send } = sentCollector();
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 1, heartbeatMs: 20, send });

  reporter.startHeartbeat();
  reporter.stopHeartbeat();
  await sleep(30);
  await reporter.flush();

  assert.equal(sent.length, 0);
});
