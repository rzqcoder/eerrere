import dotenv from "dotenv";
import { z } from "zod";

// Loads .env if present (Render/host env vars come from the dashboard instead — harmless no-op).
dotenv.config();

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(20),
  MONGODB_URI: z.string().min(10),
  /** Comma-separated guild ids the bot may operate in. Empty = reject everything (safe default). */
  ALLOWED_GUILD_IDS: z.string().default(""),
  /** Comma-separated role ids allowed to use non-public commands. Empty = anyone (admins always allowed). */
  ACCESS_ROLE_IDS: z.string().default(""),
  NODE_ENV: z.enum(["development", "production"]).default("development"),
  LOG_LEVEL: z.enum(["error", "warn", "info", "debug"]).default("info"),
  /** Port the built-in health/status HTTP server binds to. Render sets PORT for you. */
  PORT: z.coerce.number().int().min(1).max(65535).default(3007),
  /** Optional secret required as `Authorization: Bearer <token>` for GET /status. */
  STATUS_TOKEN: z.string().min(8).optional(),
});

export const env = envSchema.parse(process.env);

const splitIds = (raw: string): string[] =>
  raw
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);

/** Only these guilds may use the bot (every command/event guard checks this). */
export const ALLOWED_GUILD_IDS: string[] = splitIds(env.ALLOWED_GUILD_IDS);
/** Whitelisted role ids for non-public commands; empty list = no role gate. Admins always pass. */
export const ACCESS_ROLE_IDS: string[] = splitIds(env.ACCESS_ROLE_IDS);

if (ALLOWED_GUILD_IDS.length === 0) {
  console.warn(
    "[env] ⚠ ALLOWED_GUILD_IDS is empty — every server will be rejected and no commands will be registered. Set your server IDs in .env (see .env.example).",
  );
}
