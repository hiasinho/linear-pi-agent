import assert from "node:assert/strict";
import { before, test } from "node:test";

before(() => {
  process.env.LINEAR_CLIENT_ID = "client";
  process.env.LINEAR_CLIENT_SECRET = "secret";
  process.env.LINEAR_WEBHOOK_SECRET = "webhook";
  process.env.LINEAR_REDIRECT_URI = "https://example.com/linear/oauth/callback";
  process.env.BASE_URL = "https://example.com";
  process.env.PI_WORKDIR = "/tmp";
});

async function sessionRunnerModule() {
  return import("../src/session-runner.js");
}

test("final response body includes elapsed footer", async () => {
  const { finalResponseBody } = await sessionRunnerModule();

  assert.equal(
    finalResponseBody("pi changed files.", 252_000),
    "pi changed files.\n\n_Run completed in 4m 12s._",
  );
});

test("final response body preserves elapsed footer when summary is truncated", async () => {
  const { finalResponseBody } = await sessionRunnerModule();
  const { MAX_LINEAR_BODY_CHARS } = await import("../src/pi-runner.js");

  const body = finalResponseBody("x".repeat(MAX_LINEAR_BODY_CHARS), 1_800_000);

  assert.equal(body.length, MAX_LINEAR_BODY_CHARS);
  assert.equal(body.endsWith("\n\n_Run completed in 30m._"), true);
});

test("final error body reports timeout elapsed runtime", async () => {
  const { finalErrorBody } = await sessionRunnerModule();

  assert.equal(
    finalErrorBody({
      exitCode: null,
      signal: null,
      timedOut: true,
      stdout: "",
      stderr: "",
      outputText: "partial",
      summary: "pi failed without output.",
      elapsedMs: 1_800_000,
    }),
    "pi timed out after 30m\n\npi failed without output.",
  );
});

test("final error body reports non-timeout SDK failure elapsed runtime", async () => {
  const { finalErrorBody } = await sessionRunnerModule();

  assert.equal(
    finalErrorBody({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "boom",
      outputText: "",
      summary: "stderr:\nboom",
      elapsedMs: 12_000,
    }),
    "pi failed after 12s\n\nstderr:\nboom",
  );
});

test("stop and crash activity copy includes elapsed runtime when available", async () => {
  const { crashActivityBody, stopActivityBody } = await sessionRunnerModule();

  assert.equal(stopActivityBody(true, 128_000), "Stopped by user after 2m 8s.");
  assert.equal(stopActivityBody(false, 128_000), "Stop requested; no active pi run was in progress.");
  assert.equal(
    crashActivityBody(new Error("SDK unavailable"), 3_000),
    "Pi failed to start or run pi after 3s: SDK unavailable",
  );
});
