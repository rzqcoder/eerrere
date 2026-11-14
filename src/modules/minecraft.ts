import { SlashCommandBuilder, type Client, type ChatInputCommandInteraction } from "discord.js";
import { MC_ALLOWED_USER_IDS } from "../env";
import { EPHEMERAL, errMessage, formatDuration, makeEmbed, parseDuration, relTime, truncate } from "../core/util";
import { rconExec } from "../rcon";
import { MCTempBan } from "../db/models";
import type { Module, ModuleCommand, ModuleEvent } from "../core/types";

/** Vanilla usernames: 1–16 chars of [A-Za-z0-9_]. Also blocks command-injection via options. */
export const NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
/** IPv4 literal (dots exclude any collision with legal MC usernames). */
export const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** Kill newlines/control chars so no option can smuggle a second line into RCON. */
export const clean = (s: string): string => s.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").trim();
/** Strip MC color codes from server output. */
export const plain = (s: string): string => s.replace(/§./g, "");

export const needPlayer = (raw: string, label: string): string => {
  const v = clean(raw);
  if (!NAME_RE.test(v)) throw new Error(`\`${truncate(v, 20)}\` is not a valid Minecraft username.`);
  return v;
};

/** Valid IPv4 literal with each octet ≤255. */
export const isIpv4 = (v: string): boolean =>
  IP_RE.test(v) && v.split(".").every((o) => Number(o) <= 255);

export const needIp = (raw: string): string => {
  const v = clean(raw);
  if (!isIpv4(v)) throw new Error(`\`${truncate(v, 20)}\` is not a valid IPv4 address.`);
  return v;
};

/** Pardon command that matches how the account was banned (IP → pardon-ip). */
export const unbanCommand = (target: string): string =>
  isIpv4(target) ? `pardon-ip ${target}` : `pardon ${target}`;

const mcCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("mc")
    .setDescription("Control the Minecraft server over RCON (owner-only)")
    .addSubcommand((s) => s.setName("list").setDescription("List online players"))
    .addSubcommand((s) =>
      s
        .setName("ban")
        .setDescription("Ban a player")
        .addStringOption((o) => o.setName("player").setDescription("Username").setRequired(true).setMaxLength(16))
        .addStringOption((o) => o.setName("reason").setDescription("Ban reason").setMaxLength(200)),
    )
    .addSubcommand((s) =>
      s
        .setName("tempban")
        .setDescription("Ban a player, auto-unbanned after a duration")
        .addStringOption((o) => o.setName("player").setDescription("Username").setRequired(true).setMaxLength(16))
        .addStringOption((o) => o.setName("duration").setDescription("e.g. 30m, 2h, 7d").setRequired(true).setMaxLength(20))
        .addStringOption((o) => o.setName("reason").setDescription("Ban reason").setMaxLength(200)),
    )
    .addSubcommand((s) =>
      s
        .setName("pardon")
        .setDescription("Unban a player")
        .addStringOption((o) => o.setName("player").setDescription("Username").setRequired(true).setMaxLength(16)),
    )
    .addSubcommand((s) =>
      s
        .setName("banip")
        .setDescription("Ban an IP address (or an online player's name)")
        .addStringOption((o) => o.setName("target").setDescription("IP or online username").setRequired(true).setMaxLength(64))
        .addStringOption((o) => o.setName("reason").setDescription("Ban reason").setMaxLength(200)),
    )
    .addSubcommand((s) =>
      s
        .setName("tempbanip")
        .setDescription("Ban an IP, auto-unbanned after a duration")
        .addStringOption((o) => o.setName("ip").setDescription("IPv4 address").setRequired(true).setMaxLength(64))
        .addStringOption((o) => o.setName("duration").setDescription("e.g. 30m, 2h, 7d").setRequired(true).setMaxLength(20))
        .addStringOption((o) => o.setName("reason").setDescription("Ban reason").setMaxLength(200)),
    )
    .addSubcommand((s) =>
      s
        .setName("pardonip")
        .setDescription("Unban an IP address")
        .addStringOption((o) => o.setName("ip").setDescription("IPv4 address").setRequired(true).setMaxLength(64)),
    )
    .addSubcommand((s) =>
      s
        .setName("kick")
        .setDescription("Kick a player")
        .addStringOption((o) => o.setName("player").setDescription("Username").setRequired(true).setMaxLength(16))
        .addStringOption((o) => o.setName("reason").setDescription("Kick reason").setMaxLength(200)),
    )
    .addSubcommand((s) =>
      s
        .setName("say")
        .setDescription("Broadcast a message to the server")
        .addStringOption((o) => o.setName("message").setDescription("Message").setRequired(true).setMaxLength(300)),
    )
    .addSubcommand((s) =>
      s
        .setName("tp")
        .setDescription("Teleport a player to a player or x y z")
        .addStringOption((o) => o.setName("target").setDescription("Player to move").setRequired(true).setMaxLength(16))
        .addStringOption((o) => o.setName("destination").setDescription("Player name or x y z").setRequired(true).setMaxLength(64)),
    )
    .addSubcommand((s) =>
      s
        .setName("gamemode")
        .setDescription("Set a player's gamemode")
        .addStringOption((o) =>
          o
            .setName("mode")
            .setDescription("Gamemode")
            .setRequired(true)
            .addChoices(
              { name: "survival", value: "survival" },
              { name: "creative", value: "creative" },
              { name: "adventure", value: "adventure" },
              { name: "spectator", value: "spectator" },
            ),
        )
        .addStringOption((o) => o.setName("player").setDescription("Username").setRequired(true).setMaxLength(16)),
    )
    .addSubcommand((s) =>
      s
        .setName("whitelist")
        .setDescription("Manage the whitelist")
        .addStringOption((o) =>
          o
            .setName("action")
            .setDescription("Action")
            .setRequired(true)
            .addChoices(
              { name: "list", value: "list" },
              { name: "add player", value: "add" },
              { name: "remove player", value: "remove" },
              { name: "turn on", value: "on" },
              { name: "turn off", value: "off" },
            ),
        )
        .addStringOption((o) => o.setName("player").setDescription("Username (add/remove only)").setMaxLength(16)),
    )
    .addSubcommand((s) =>
      s
        .setName("run")
        .setDescription("Run any raw console command (op, give, time, weather, stop …)")
        .addStringOption((o) => o.setName("command").setDescription("Without the leading /").setRequired(true).setMaxLength(400)),
    ),
  // public: the registry role-gate is skipped; the user-id allowlist inside run() is the real gate.
  public: true,
  run: async (_client: Client, interaction: ChatInputCommandInteraction): Promise<void> => {
    if (!MC_ALLOWED_USER_IDS.includes(interaction.user.id)) {
      await interaction
        .reply({ content: "⛔ Only the server owners can control Minecraft over Discord.", flags: EPHEMERAL })
        .catch(() => undefined);
      return;
    }

    await interaction.deferReply({ flags: EPHEMERAL });
    try {
      await executeSub(interaction);
    } catch (err) {
      await interaction.editReply({ content: `❌ ${errMessage(err)}` }).catch(() => undefined);
    }
  },
};

async function executeSub(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand();
  const str = (n: string): string => interaction.options.getString(n) ?? "";
  let command: string;
  let label = sub;
  let afterExec: (() => Promise<void>) | null = null;

  switch (sub) {
    case "list": {
      command = "list";
      label = "Players online";
      break;
    }
    case "ban": {
      const p = needPlayer(str("player"), "player");
      const r = clean(str("reason"));
      command = r ? `ban ${p} ${r}` : `ban ${p}`;
      label = `Ban ${p}`;
      break;
    }
    case "tempban": {
      const p = needPlayer(str("player"), "player");
      const ms = parseDuration(str("duration"));
      if (!ms || ms < 30_000) throw new Error("Invalid duration. Use formats like `30m`, `2h`, `7d` (min 30s).");
      if (ms > 365 * 86_400_000) throw new Error("Tempban is limited to 365 days.");
      const r = clean(str("reason")) || "Tempbanned";
      const unbanAt = await doTempban(p, ms, r, interaction.user.id);
      const embed = makeEmbed()
        .setTitle(`🔨 Tempbanned ${p}`)
        .setDescription(`${r}\nUnbans ${relTime(unbanAt)} (${formatDuration(ms)}).`);
      await interaction.editReply({ embeds: [embed] });
      return;
    }
    case "banip": {
      const t = clean(str("target"));
      const target = isIpv4(t) ? t : needPlayer(t, "target");
      const r = clean(str("reason"));
      command = r ? `ban-ip ${target} ${r}` : `ban-ip ${target}`;
      label = `IP-banned ${target}`;
      break;
    }
    case "tempbanip": {
      const ip = needIp(str("ip"));
      const ms = parseDuration(str("duration"));
      if (!ms || ms < 30_000) throw new Error("Invalid duration. Use formats like `30m`, `2h`, `7d` (min 30s).");
      if (ms > 365 * 86_400_000) throw new Error("Tempban is limited to 365 days.");
      const r = clean(str("reason")) || "Tempbanned";
      const unbanAt = await doTempbanIp(ip, ms, r, interaction.user.id);
      const embed = makeEmbed()
        .setTitle(`🔨 Tempbanned IP ${ip}`)
        .setDescription(`${r}\nUnbans ${relTime(unbanAt)} (${formatDuration(ms)}).`);
      await interaction.editReply({ embeds: [embed] });
      return;
    }
    case "pardonip": {
      const ip = needIp(str("ip"));
      command = `pardon-ip ${ip}`;
      label = `Unbanned IP ${ip}`;
      // Clear a pending auto-unban for this IP once the pardon lands (post-exec block).
      afterExec = async () => {
        await MCTempBan.deleteMany({ player: ip });
      };
      break;
    }
    case "pardon": {
      const p = needPlayer(str("player"), "player");
      command = `pardon ${p}`;
      label = `Unbanned ${p}`;
      // Manual unban overrides any pending auto-unban — deleted after RCON succeeds
      // (see post-exec block) so a failed pardon can't drop the record.
      afterExec = async () => {
        await MCTempBan.deleteMany({ player: p });
      };
      break;
    }
    case "kick": {
      const p = needPlayer(str("player"), "player");
      const r = clean(str("reason"));
      command = r ? `kick ${p} ${r}` : `kick ${p}`;
      label = `Kicked ${p}`;
      break;
    }
    case "say": {
      const m = clean(str("message"));
      if (!m) throw new Error("Message is empty.");
      command = `say ${m}`;
      label = "Broadcast";
      break;
    }
    case "tp": {
      const target = needPlayer(str("target"), "target");
      const dest = clean(str("destination"));
      const tokens = dest.split(/\s+/);
      if (tokens.length === 1) {
        if (!NAME_RE.test(dest)) throw new Error("Destination must be a player name or `x y z` coordinates.");
      } else {
        if (tokens.length !== 3 || !tokens.every((t) => /^~?-?\d+(\.\d+)?$|^~$/.test(t))) {
          throw new Error("Destination must be a player name or `x y z` coordinates.");
        }
      }
      command = `tp ${target} ${tokens.join(" ")}`;
      label = `Teleport ${target}`;
      break;
    }
    case "gamemode": {
      const mode = str("mode");
      const p = needPlayer(str("player"), "player");
      command = `gamemode ${mode} ${p}`;
      label = `Gamemode ${mode} → ${p}`;
      break;
    }
    case "whitelist": {
      const action = str("action");
      if (action === "add" || action === "remove") {
        const p = needPlayer(str("player") ?? "", "player");
        command = `whitelist ${action} ${p}`;
      } else {
        command = `whitelist ${action}`;
      }
      label = `Whitelist ${action}`;
      break;
    }
    case "run": {
      const raw = clean(str("command")).replace(/^\/+/, "");
      if (!raw) throw new Error("Command is empty.");
      command = raw;
      label = `Ran: ${truncate(raw, 80)}`;
      break;
    }
    default:
      throw new Error("Unknown subcommand.");
  }

  const out = plain(await rconExec(command));
  if (afterExec) await afterExec();
  const embed = makeEmbed().setTitle(`✅ ${label}`).setDescription(out ? truncate(out, 1000) : "Done (server gave no output).");
  await interaction.editReply({ embeds: [embed] });
}

/* Ban now + record an auto-unban (record-first: a failed ban can never leave a
   player banned forever). Shared by /mc tempban, /mc tempbanip and the panel. */
export async function doTempban(p: string, ms: number, r: string, byId: string): Promise<Date> {
  const unbanAt = new Date(Date.now() + ms);
  await MCTempBan.updateOne(
    { player: p },
    { player: p, unbanAt, requestedBy: byId, reason: r, createdAt: new Date() },
    { upsert: true },
  );
  try {
    await rconExec(`ban ${p} ${r} [auto-unban ${unbanAt.toISOString()}]`);
  } catch (err) {
    await MCTempBan.deleteOne({ player: p, unbanAt });
    throw err;
  }
  return unbanAt;
}

export async function doTempbanIp(ip: string, ms: number, r: string, byId: string): Promise<Date> {
  const unbanAt = new Date(Date.now() + ms);
  await MCTempBan.updateOne(
    { player: ip },
    { player: ip, unbanAt, requestedBy: byId, reason: r, createdAt: new Date() },
    { upsert: true },
  );
  try {
    await rconExec(`ban-ip ${ip} ${r} [auto-unban ${unbanAt.toISOString()}]`);
  } catch (err) {
    await MCTempBan.deleteOne({ player: ip, unbanAt });
    throw err;
  }
  return unbanAt;
}

/* Auto-unban sweeper: same pattern as the giveaway sweeper. */
let sweepStarted = false;
const sweepReadyEvent: ModuleEvent = {
  name: "clientReady" as const,
  run: async (): Promise<void> => {
    if (sweepStarted) return;
    sweepStarted = true;
    const sweep = async () => {
      try {
        const due = await MCTempBan.find({ unbanAt: { $lte: new Date() } });
        for (const doc of due) {
          try {
            await rconExec(unbanCommand(doc.player));
            await MCTempBan.deleteOne({ _id: doc._id });
            console.log(`[minecraft] tempban expired — pardoned ${doc.player}`);
          } catch (err) {
            console.error(`[minecraft] pardon failed for ${doc.player} (will retry next sweep):`, err);
          }
        }
      } catch (err) {
        console.error("[minecraft] tempban sweep failed:", err);
      }
    };
    await sweep();
    setInterval(() => {
      void sweep();
    }, 30_000);
  },
};

export const minecraftModule: Module = {
  name: "minecraft",
  description: "Minecraft server control over RCON: ban, tempban, kick, list, say, tp and more",
  defaultEnabled: true,
  commands: [mcCommand],
  events: [sweepReadyEvent],
};
