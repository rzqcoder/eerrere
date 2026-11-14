import {
  ActivityType,
  SlashCommandBuilder,
  type Client,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
} from "discord.js";
import { MC_ALLOWED_USER_IDS } from "../env";
import { config } from "../core/config";
import { EPHEMERAL, errMessage, makeEmbed, truncate } from "../core/util";
import { rconExec } from "../rcon";
import type { Module, ModuleCommand, ModuleEvent } from "../core/types";

/** players/max/tps/cpu/ram — tps/cpu/ram are null when StatusBridge plugin is absent. */
interface Stats {
  online: boolean;
  players?: number;
  max?: number;
  tps?: number | null;
  cpu?: number | null;
  ram?: number | null;
  names?: string[];
}

const EDIT_MS = 15_000; // status embed refresh + presence rotation cadence

const rconConfigured = (): boolean => (process.env.MC_RCON_HOST ?? "").trim().length > 0;

/** 1.12: "There are 3 out of maximum 20 players online: a, b" — older: "There are 3/20 players online: …" */
const parseList = (out: string): { players?: number; max?: number; names?: string[] } => {
  const m = out.match(/There are (\d+)(?:\s*out of maximum|\/)\s*(\d+) players online\.?(?:\s*:\s*(.*))?/i);
  if (!m) return {};
  const names = m[3]?.trim() ? m[3].split(",").map((n) => n.trim()).filter(Boolean) : undefined;
  return { players: Number(m[1]), max: Number(m[2]), names };
};

/** StatusBridge JSON when available, else vanilla /list (no tps/cpu/ram), else offline. */
async function fetchStats(): Promise<Stats> {
  if (!rconConfigured()) return { online: false };
  try {
    let out = await rconExec("mcstatus", 6000);
    const json = out.match(/\{[\s\S]*\}/);
    if (json) {
      try {
        const j = JSON.parse(json[0]) as Record<string, unknown>;
        return {
          online: true,
          players: typeof j.players === "number" ? j.players : undefined,
          max: typeof j.max === "number" ? j.max : undefined,
          tps: typeof j.tps === "number" && j.tps >= 0 ? j.tps : null,
          cpu: typeof j.cpu === "number" && j.cpu >= 0 ? j.cpu : null,
          ram: typeof j.ram === "number" && j.ram >= 0 ? j.ram : null,
          names: Array.isArray(j.names) ? (j.names as string[]) : undefined,
        };
      } catch {
        /* not JSON → fall through to list */
      }
    }
    const list = await rconExec("list", 6000);
    return { online: true, ...parseList(list), tps: null, cpu: null, ram: null };
  } catch {
    return { online: false };
  }
}

function statusEmbed(s: Stats): EmbedBuilder {
  if (!s.online) {
    return makeEmbed()
      .setTitle("🔴 Minecraft Server — OFFLINE")
      .setDescription(
        rconConfigured()
          ? "Could not reach the server over RCON (down, or wrong host/port)."
          : "RCON is not configured — set MC_RCON_HOST / MC_RCON_PORT / MC_RCON_PASSWORD.",
      )
      .setTimestamp();
  }
  const e = makeEmbed()
    .setTitle("🟢 Minecraft Server — ONLINE")
    .setDescription(`Playing Minecraft: ${s.players ?? "?"} / ${s.max ?? "?"} players online`)
    .addFields(
      { name: "Players", value: `${s.players ?? "?"} / ${s.max ?? "?"}`, inline: true },
      { name: "TPS", value: s.tps != null ? s.tps.toFixed(1) : "—", inline: true },
      { name: "CPU", value: s.cpu != null ? `${s.cpu.toFixed(1)}%` : "—", inline: true },
      { name: "RAM", value: s.ram != null ? `${s.ram.toFixed(1)}%` : "—", inline: true },
    )
    .setTimestamp();
  if (s.names?.length) {
    e.addFields({ name: `Online now (${s.players ?? s.names.length})`, value: truncate(s.names.join(", "), 1000) });
  }
  return e;
}

/** Rotating presence: player count → cpu&ram → tps (missing stats are skipped). */
function presenceFor(s: Stats, idx: number): { type: ActivityType; name: string } | null {
  if (!s.online) return { type: ActivityType.Playing, name: "Minecraft: server offline" };
  const entries: { type: ActivityType; name: string }[] = [
    { type: ActivityType.Playing, name: `Minecraft: ${s.players ?? "?"}/${s.max ?? "?"} players online` },
  ];
  if (s.cpu != null || s.ram != null) {
    const cpu = s.cpu != null ? `${s.cpu.toFixed(0)}%` : "—";
    const ram = s.ram != null ? `${s.ram.toFixed(0)}%` : "—";
    entries.push({ type: ActivityType.Watching, name: `Minecraft CPU ${cpu} | RAM ${ram}` });
  }
  if (s.tps != null) entries.push({ type: ActivityType.Watching, name: `Minecraft TPS: ${s.tps.toFixed(1)}` });
  return entries[idx % entries.length];
}

/** Live /status message target (last one wins; cleared automatically if deleted). */
let editTarget: ((s: Stats) => Promise<void>) | null = null;
let lastStats: Stats = { online: false };
let rotationIdx = 0;
let loopStarted = false;
let tickBusy = false;
let lastPresence = "";

/** Set presence only when it actually changes; never let it throw the loop. */
function applyPresence(client: Client, type: ActivityType, name: string): void {
  const key = `${type}:${name}`;
  if (key === lastPresence) return;
  lastPresence = key;
  try {
    client.user?.setPresence({ activities: [{ name, type }] });
    console.log(`[status] presence → ${name}`);
  } catch (err) {
    console.error("[status] setPresence failed:", err);
  }
}

const statusCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Post the live Minecraft status message (players / TPS / CPU / RAM) — owner-only"),
  // public: registry role-gate skipped; the user-id allowlist below is the real gate.
  public: true,
  run: async (_client: Client, interaction: ChatInputCommandInteraction): Promise<void> => {
    if (!MC_ALLOWED_USER_IDS.includes(interaction.user.id)) {
      await interaction
        .reply({ content: "⛔ Only the server owners can post the status message.", flags: EPHEMERAL })
        .catch(() => undefined);
      return;
    }
    await interaction.deferReply();
    const stats = await fetchStats();
    const msg = await interaction
      .editReply({ embeds: [statusEmbed(stats)] })
      .catch(() => null);
    if (!msg) return;
    editTarget = async (s: Stats) => {
      await msg.edit({ embeds: [statusEmbed(s)] }).catch(() => {
        editTarget = null; // message deleted → stop updating it
      });
    };
    if (!rconConfigured()) {
      await interaction.followUp({ content: "⚠ RCON not configured — status will show OFFLINE.", flags: EPHEMERAL }).catch(() => undefined);
    }
  },
};

const readyEvent: ModuleEvent = {
  name: "clientReady" as const,
  run: async (client: Client): Promise<void> => {
    if (loopStarted) return;
    loopStarted = true;
    const tick = async (): Promise<void> => {
      if (tickBusy) return; // previous fetch still running — don't stack
      tickBusy = true;
      try {
        if (!rconConfigured()) {
          // No MC_RCON_HOST → we can't read stats. Show the static presence
          // instead of clearing activities (an empty presence looks "broken").
          console.warn("[status] MC_RCON_HOST not set — rotating presence disabled, using static presence.");
          applyPresence(client, config.presence.type, config.presence.name);
          return;
        }
        lastStats = await fetchStats();
        if (editTarget) await editTarget(lastStats);
        const act = presenceFor(lastStats, rotationIdx++);
        if (act) applyPresence(client, act.type, act.name);
      } catch (err) {
        console.error("[status] tick failed:", err);
      } finally {
        tickBusy = false;
      }
    };
    // Interval FIRST: even if the initial tick throws, the loop must keep running.
    setInterval(() => {
      void tick();
    }, EDIT_MS);
    await tick();
  },
};

export const statusModule: Module = {
  name: "status",
  description: "Live Minecraft status message + rotating bot presence (players, TPS, CPU/RAM)",
  defaultEnabled: true,
  commands: [statusCommand],
  events: [readyEvent],
};
