import "dotenv/config";
import { z } from "zod";

const emptyStringAsUndefined = (value: unknown) => value === "" ? undefined : value;

const ConfigSchema = z.object({
  LINEAR_CLIENT_ID: z.string().min(1),
  LINEAR_CLIENT_SECRET: z.string().min(1),
  LINEAR_WEBHOOK_SECRET: z.string().min(1),
  INSTALL_SECRET: z.preprocess(emptyStringAsUndefined, z.string().min(16).optional()),
  LINEAR_REDIRECT_URI: z.string().url(),
  BASE_URL: z.string().url(),
  PI_WORKDIR: z.string().min(1),
  PI_COMMAND: z.string().min(1).default("pi"),
  PI_MODE: z.enum(["text", "json"]).default("json"),
  PI_RUNNER: z.enum(["sdk", "cli"]).default("sdk"),
  PI_THEME: z.preprocess(emptyStringAsUndefined, z.string().trim().min(1).default("light")),
  PI_SESSION_DIR: z.string().default("./data/pi-sessions"),
  PI_PROGRESS_DEBOUNCE_MS: z.coerce.number().int().positive().default(3_000),
  PI_PROGRESS_HEARTBEAT_MS: z.coerce.number().int().positive().default(300_000),
  PI_PROGRESS_LONG_TOOL_MS: z.coerce.number().int().nonnegative().default(30_000),
  PI_TIMEOUT_MS: z.coerce.number().int().positive().default(1_800_000),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8787),
  TOKEN_STORE_PATH: z.string().default("./data/linear-tokens.json"),
  STATE_STORE_PATH: z.string().default("./data/oauth-states.json"),
});

export const config = ConfigSchema.parse(process.env);

export function publicConfig() {
  return {
    baseUrl: config.BASE_URL,
    redirectUri: config.LINEAR_REDIRECT_URI,
    installSecretConfigured: Boolean(config.INSTALL_SECRET),
    piWorkdir: config.PI_WORKDIR,
    piCommand: config.PI_COMMAND,
    piMode: config.PI_MODE,
    piRunner: config.PI_RUNNER,
    piTheme: config.PI_THEME,
    piSessionDir: config.PI_SESSION_DIR,
    piProgressDebounceMs: config.PI_PROGRESS_DEBOUNCE_MS,
    piProgressHeartbeatMs: config.PI_PROGRESS_HEARTBEAT_MS,
    piProgressLongToolMs: config.PI_PROGRESS_LONG_TOOL_MS,
    piTimeoutMs: config.PI_TIMEOUT_MS,
    host: config.HOST,
    port: config.PORT,
    tokenStorePath: config.TOKEN_STORE_PATH,
    stateStorePath: config.STATE_STORE_PATH,
  };
}
