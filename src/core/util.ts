import { EmbedBuilder, MessageFlags, type BaseInteraction } from "discord.js";
import { config } from "./config";

export const EPHEMERAL = MessageFlags.Ephemeral;

/** Reply or editReply depending on interaction state. Used for errors / short notices. */
export async function safeReply(interaction: BaseInteraction, content: string): Promise<void> {
  try {
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content }).catch(() => undefined);
      } else {
        await interaction.reply({ content, flags: EPHEMERAL }).catch(() => undefined);
      }
    }
  } catch {
    // swallow – we never want a failed promise from the error path itself
  }
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function makeEmbed(discordColor = config.embedColors.primary): EmbedBuilder {
  return new EmbedBuilder().setColor(discordColor);
}

/** Parse "10m", "1h30m", "2d", bare "45" (seconds) into ms; null when invalid. */
export function parseDuration(input: string): number | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10) * 1000;
  let total = 0;
  let matched = false;
  for (const m of raw.matchAll(/(\d+)\s*(w|d|h|m|s)/gi)) {
    const n = parseInt(m[1]!, 10);
    const unit = m[2]!.toLowerCase();
    const mult =
      unit === "w" ? 7 * 86_400_000 : unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1000;
    total += n * mult;
    matched = true;
  }
  return matched ? total : null;
}

/** Human friendly duration like "1d 3h 20m". */
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0s";
  const units: Array<[string, number]> = [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1000],
  ];
  const parts: string[] = [];
  let rest = ms;
  for (const [label, size] of units) {
    const value = Math.floor(rest / size);
    if (value > 0) {
      parts.push(`${value}${label}`);
      rest -= value * size;
    }
  }
  return parts.join(" ") || "0s";
}

/** Discord relative timestamp from a Date. */
export function relTime(date: Date): string {
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

export const toLocale = (n: number): string => n.toLocaleString("en-US");

export const truncate = (text: string, max = 1024): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

export function pickRandom<T>(items: T[], count: number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]!);
  }
  return out;
}
