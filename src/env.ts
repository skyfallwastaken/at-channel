import { z } from "zod";

export const Env = z.object({
  TURSO_CONNECTION_URL: z.string(),
  TURSO_AUTH_TOKEN: z.string(),

  SLACK_APP_TOKEN: z.string(),
  SLACK_BOT_TOKEN: z.string(),

  SLACK_XOXC: z.string(),
  SLACK_XOXD: z.string(),

  LOGSNAG_TOKEN: z.string(),
  LOGSNAG_PROJECT: z.string(),

  LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error", "fatal"])
    .default("info"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
});
export const env = Env.parse(process.env);
