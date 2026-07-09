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

test("tool_execution_start reports sanitized useful progress", async () => {
  const { ProgressReporter, handleSdkEvent } = await progressModule();
  const { sent, send } = sentCollector();
  const reporter = new ProgressReporter({ agentSessionId: "session", debounceMs: 1, send });

  handleSdkEvent({ type: "tool_execution_start", toolName: "bash", args: { command: "echo TOKEN=abc123" } } as never, reporter);
  await reporter.flush();

  assert.deepEqual(sent, [{ type: "thought", body: "Running bash: bash echo TOKEN=[redacted]" }]);
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
