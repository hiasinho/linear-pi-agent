import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const execFileAsync = promisify(execFile);

async function loadConfig(env: Record<string, string | undefined> = {}) {
  const { stdout } = await execFileAsync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    `const { config, publicConfig } = await import("./src/config.ts");
console.log(JSON.stringify({ config, publicConfig: publicConfig() }));`,
  ], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DOTENV_CONFIG_PATH: "/dev/null",
      LINEAR_CLIENT_ID: "client",
      LINEAR_CLIENT_SECRET: "secret",
      LINEAR_WEBHOOK_SECRET: "webhook",
      INSTALL_SECRET: "",
      LINEAR_REDIRECT_URI: "https://example.com/linear/oauth/callback",
      BASE_URL: "https://example.com",
      PI_WORKDIR: "/tmp",
      PI_PROGRESS_DEBOUNCE_MS: "1234",
      PI_PROGRESS_HEARTBEAT_MS: "5678",
      PI_TIMEOUT_MS: "9012",
      ...env,
    },
  });

  return JSON.parse(stdout) as {
    config: { PI_THEME: string };
    publicConfig: {
      piTheme: string;
      piProgressDebounceMs: number;
      piProgressHeartbeatMs: number;
      piTimeoutMs: number;
    };
  };
}

test("PI_THEME defaults to light", async () => {
  const result = await loadConfig({ PI_THEME: undefined });

  assert.equal(result.config.PI_THEME, "light");
});

test("PI_THEME accepts custom theme names", async () => {
  const result = await loadConfig({ PI_THEME: "nord" });

  assert.equal(result.config.PI_THEME, "nord");
});

test("empty PI_THEME falls back to light", async () => {
  const result = await loadConfig({ PI_THEME: "" });

  assert.equal(result.config.PI_THEME, "light");
});

test("publicConfig includes safe Pi runtime settings", async () => {
  const result = await loadConfig({ PI_THEME: "custom-theme" });

  assert.equal(result.publicConfig.piTheme, "custom-theme");
  assert.equal(result.publicConfig.piProgressDebounceMs, 1234);
  assert.equal(result.publicConfig.piProgressHeartbeatMs, 5678);
  assert.equal(result.publicConfig.piTimeoutMs, 9012);
});
