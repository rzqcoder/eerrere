import { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder, ChannelType } from "discord.js";
import { GuildConfig } from "../db/models";
import { getGuildConfig, invalidateGuildConfig } from "../db/guildConfig";
import { EPHEMERAL, relTime, makeEmbed } from "../core/util";
import { config } from "../core/config";
import type { Module, ModuleCommand } from "../core/types";
import type { Message, GuildMember } from "discord.js";

const DEFAULT_SPAM = { enabled: false, threshold: 8, windowSec: 5, timeoutSec: 600 };
const DEFAULT_RAID = { enabled: false, threshold: 12, windowSec: 10, lockdownSec: 120, alertChannelId: null };
const DEFAULT_BOT = { enabled: false, allowlist: [], action: "kick" };

const LINK_RE = /(?:https?:\/\/|www\.)\S+/i;
const INVITE_RE = /(?:discord\.(?:gg|io|me|li|com)\/(?:invite\/)?|dsc\.(?:gg|io))\S+/i;

/* --------------------------------- in-memory trackers -------------------------------- */

const spamTracker = new Map<string, number[]>(); // guild:userId -> timestamps
const spamStrikes = new Map<string, number>();
const joinTracker = new Map<string, number[]>(); // guild -> join timestamps
const guildLockUntil = new Map<string, number>(); // guild -> lockdown restores at
const lastRaidAlert = new Map<string, number>();

/* -------------------------------------- helpers -------------------------------------- */

async function sendSecurityAlert(
  client: any,
  guildId: string,
  channelId: string | undefined,
  embed: EmbedBuilder,
): Promise<void> {
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !("send" in channel)) return;
  await (channel as any).send({ embeds: [embed] }).catch(() => undefined);
}

async function lockChannel(channel: any, locked: boolean, reason: string): Promise<void> {
  if (!channel?.guild || !("permissionOverwrites" in channel)) return;
  await channel.permissionOverwrites
    .edit(
      channel.guild.roles.everyone,
      locked ? { SendMessages: false, AddReactions: false } : { SendMessages: null, AddReactions: null },
      { reason },
    )
    .catch(() => undefined);
}

function pruneList(list: number[], windowMs: number, now: number): number[] {
  return list.filter((t) => now - t < windowMs);
}

/* -------------------------------------- commands ------------------------------------- */

const securityCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("security")
    .setDescription("Security automation controls")
    .addSubcommand((sub) => sub.setName("status").setDescription("View the current security configuration"))
    .addSubcommand((sub) =>
      sub
        .setName("antispam")
        .setDescription("Configure anti-spam")
        .addBooleanOption((opt) => opt.setName("enabled").setDescription("Enable anti-spam").setRequired(true))
        .addIntegerOption((opt) => opt.setName("threshold").setDescription("Messages allowed per window (default 8)"))
        .addIntegerOption((opt) => opt.setName("window").setDescription("Window in seconds (default 5)"))
        .addIntegerOption((opt) => opt.setName("timeout").setDescription("Spammer timeout in seconds (default 600)")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("antiraid")
        .setDescription("Configure anti-raid")
        .addBooleanOption((opt) => opt.setName("enabled").setDescription("Enable anti-raid").setRequired(true))
        .addIntegerOption((opt) => opt.setName("threshold").setDescription("Joins allowed per window (default 12)"))
        .addIntegerOption((opt) => opt.setName("window").setDescription("Window in seconds (default 10)"))
        .addIntegerOption((opt) =>
          opt.setName("lockdown").setDescription("Auto-lockdown seconds after a raid (0 = off, default 120)"),
        )
        .addChannelOption((opt) =>
          opt
            .setName("alert_channel")
            .setDescription("Channel that receives raid alerts")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("antilink")
        .setDescription("Configure anti-link")
        .addBooleanOption((opt) => opt.setName("enabled").setDescription("Enable anti-link").setRequired(true))
        .addStringOption((opt) =>
          opt.setName("allowlist").setDescription("Comma-separated domains that are allowed").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("botjoin")
        .setDescription("Configure bot join protection")
        .addBooleanOption((opt) => opt.setName("enabled").setDescription("Enable bot protection").setRequired(true))
        .addStringOption((opt) =>
          opt
            .setName("action")
            .setDescription("Action on unauthorized bots")
            .setRequired(true)
            .addChoices({ name: "kick", value: "kick" }, { name: "ban", value: "ban" }),
        )
        .addStringOption((opt) =>
          opt.setName("allowlist").setDescription("Comma-separated allowed bot user IDs").setRequired(false),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("lockdown")
        .setDescription("Lock or unlock a text channel")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to lock")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        )
        .addBooleanOption((opt) => opt.setName("locked").setDescription("true = lock, false = unlock").setRequired(true))
        .addStringOption((opt) => opt.setName("reason").setDescription("Audit log reason")),
    ),
  run: async (_client, interaction) => {
    await interaction.deferReply({ flags: EPHEMERAL });
    const guildId = interaction.guildId;
    if (!guildId) return;
    const sub = interaction.options.getSubcommand();
    const cfg = await getGuildConfig(guildId);

    if (sub === "status") {
      const s = cfg.security;
      const fmt = (o: any) => (o?.enabled ? "🟢 on" : "🔴 off");
      const embed = makeEmbed(config.embedColors.primary)
        .setTitle("Security status")
        .setDescription(
          [
            `- anti-spam: ${fmt(s?.antiSpam)} (threshold ${s?.antiSpam?.threshold ?? DEFAULT_SPAM.threshold}/${s?.antiSpam?.windowSec ?? DEFAULT_SPAM.windowSec}s, timeout ${s?.antiSpam?.timeoutSec ?? DEFAULT_SPAM.timeoutSec}s)`,
            `- anti-raid: ${fmt(s?.antiRaid)} (threshold ${s?.antiRaid?.threshold ?? DEFAULT_RAID.threshold}/${s?.antiRaid?.windowSec ?? DEFAULT_RAID.windowSec}s, lockdown ${s?.antiRaid?.lockdownSec ?? DEFAULT_RAID.lockdownSec}s)`,
            `- anti-link: ${fmt(s?.antiLink)} (allowlist: ${s?.antiLink?.allowlist?.length ? s.antiLink.allowlist.join(", ") : "none"})`,
            `- bot protection: ${fmt(s?.botProtection)} (action ${s?.botProtection?.action ?? "kick"})`,
            `- current lockdown: ${guildLockUntil.get(guildId) && guildLockUntil.get(guildId)! > Date.now() ? relTime(new Date(guildLockUntil.get(guildId)!)) : "none"}`,
          ].join("\n"),
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const patch: Record<string, unknown> = {};

    if (sub === "antispam") {
      patch["security.antiSpam.enabled"] = interaction.options.getBoolean("enabled", true);
      const threshold = interaction.options.getInteger("threshold");
      const window = interaction.options.getInteger("window");
      const timeout = interaction.options.getInteger("timeout");
      if (threshold !== null) patch["security.antiSpam.threshold"] = threshold;
      if (window !== null) patch["security.antiSpam.windowSec"] = window;
      if (timeout !== null) patch["security.antiSpam.timeoutSec"] = timeout;
    } else if (sub === "antiraid") {
      patch["security.antiRaid.enabled"] = interaction.options.getBoolean("enabled", true);
      const threshold = interaction.options.getInteger("threshold");
      const window = interaction.options.getInteger("window");
      const lockdown = interaction.options.getInteger("lockdown");
      if (threshold !== null) patch["security.antiRaid.threshold"] = threshold;
      if (window !== null) patch["security.antiRaid.windowSec"] = window;
      if (lockdown !== null) patch["security.antiRaid.lockdownSec"] = lockdown;
      const alertChannel = interaction.options.getChannel("alert_channel");
      if (alertChannel) patch["security.antiRaid.alertChannelId"] = alertChannel.id;
    } else if (sub === "antilink") {
      const enabled = interaction.options.getBoolean("enabled", true);
      const allowlist = (interaction.options.getString("allowlist") ?? "")
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
      patch["security.antiLink.enabled"] = enabled;
      if (interaction.options.getString("allowlist") !== null) patch["security.antiLink.allowlist"] = allowlist;
    } else if (sub === "botjoin") {
      patch["security.botProtection.enabled"] = interaction.options.getBoolean("enabled", true);
      patch["security.botProtection.action"] = interaction.options.getString("action", true);
      const allowlistRaw = interaction.options.getString("allowlist");
      if (allowlistRaw !== null) {
        patch["security.botProtection.allowlist"] = allowlistRaw.split(",").map((v) => v.trim()).filter(Boolean);
      }
    } else if (sub === "lockdown") {
      const channel = interaction.options.getChannel("channel", true);
      const locked = interaction.options.getBoolean("locked", true);
      const reason = interaction.options.getString("reason") ?? "Manual lockdown";
      await lockChannel(channel, locked, reason);
      await interaction.editReply(`${locked ? "🔒 Locked" : "🔓 Unlocked"} ${channel}`);
      return;
    }

    await GuildConfig.updateOne({ guildId }, { $set: patch }, { upsert: true });
    invalidateGuildConfig(guildId);
    await getGuildConfig(guildId, { fresh: true });
    await interaction.editReply(`✅ Saved. Run \`/security status\` to review.`);
  },
};

/* -------------------------------------- events --------------------------------------- */

const onMessageCreate = async (client: any, message: Message): Promise<void> => {
  if (!message.inGuild() || message.author.bot || !message.member) return;
  const guild = message.guild;
  const userId = message.author.id;
  const key = `${guild.id}:${userId}`;
  const cfg = await getGuildConfig(guild.id);
  const sec = cfg.security;

  if (message.member.permissions.has(PermissionFlagsBits.Administrator)) return;

  // anti-link
  const antiLink = sec?.antiLink;
  if (antiLink?.enabled) {
    const isLink = LINK_RE.test(message.content) || INVITE_RE.test(message.content);
    if (isLink) {
      const lower = message.content.toLowerCase();
      const allowed = (antiLink.allowlist ?? []).some((domain) => lower.includes(domain.toLowerCase()));
      if (!allowed) {
        await message.delete().catch(() => undefined);
        await message.channel.send({ content: `${message.author}, links are not allowed here.` }).then((m) => {
          setTimeout(() => m.delete().catch(() => undefined), 5000);
        }).catch(() => undefined);
        return;
      }
    }
  }

  // anti-spam
  const antiSpam = sec?.antiSpam;
  if (antiSpam?.enabled) {
    const windowMs = (antiSpam.windowSec ?? DEFAULT_SPAM.windowSec) * 1000;
    const threshold = antiSpam.threshold ?? DEFAULT_SPAM.threshold;
    const now = Date.now();
    const list = pruneList(spamTracker.get(key) ?? [], windowMs, now);
    list.push(now);
    spamTracker.set(key, list);
    if (list.length > threshold) {
      await message.delete().catch(() => undefined);
      const strikes = (spamStrikes.get(key) ?? 0) + 1;
      spamStrikes.set(key, strikes);
      spamTracker.set(key, []);
      if (strikes >= 3 && message.member.moderatable) {
        const timeoutMs = (antiSpam.timeoutSec ?? DEFAULT_SPAM.timeoutSec);
        await message.member.timeout(timeoutMs, "Anti-spam: repeated flooding").catch(() => undefined);
        spamStrikes.set(key, 0);
      }
      return;
    }
  }
};

const onGuildMemberAdd = async (client: any, member: GuildMember): Promise<void> => {
  const guild = member.guild;
  const cfg = await getGuildConfig(guild.id);
  const sec = cfg.security;

  // bot protection
  const bot = sec?.botProtection;
  if (bot?.enabled && member.user.bot && !(bot.allowlist ?? []).includes(member.user.id)) {
    const action = bot.action ?? "kick";
    if (action === "ban") await member.ban({ reason: "Bot protection: unauthorized bot" }).catch(() => undefined);
    else await member.kick("Bot protection: unauthorized bot").catch(() => undefined);
    return;
  }

  // anti-raid
  const raid = sec?.antiRaid;
  if (raid?.enabled) {
    const windowMs = (raid.windowSec ?? DEFAULT_RAID.windowSec) * 1000;
    const threshold = raid.threshold ?? DEFAULT_RAID.threshold;
    const now = Date.now();
    const joins = pruneList(joinTracker.get(guild.id) ?? [], windowMs, now);
    joins.push(now);
    joinTracker.set(guild.id, joins);

    const alertedRecently = lastRaidAlert.get(guild.id) ?? 0;
    if (joins.length > threshold) {
      const lockdownSec = raid.lockdownSec ?? DEFAULT_RAID.lockdownSec;
      const embed = makeEmbed(config.embedColors.danger)
        .setTitle("🚨 Possible raid detected")
        .setDescription(
          [
            `**${joins.length}** members joined within the last **${raid.windowSec ?? DEFAULT_RAID.windowSec}s**.`,
            lockdownSec > 0 ? `Lockdown enabled for **${lockdownSec}s**.` : "Lockdown disabled.",
          ].join("\n"),
        );
      if (now - alertedRecently > 30_000) {
        lastRaidAlert.set(guild.id, now);
        await sendSecurityAlert(client, guild.id, raid.alertChannelId, embed);
      }
      if (lockdownSec > 0 && !(guildLockUntil.get(guild.id) ?? 0 > now)) {
        guildLockUntil.set(guild.id, now + lockdownSec * 1000);
        const targets = guild.channels.cache.filter(
          (c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement,
        );
        for (const [, ch] of targets) await lockChannel(ch, true, "Anti-raid auto lockdown").catch(() => undefined);
        setTimeout(() => {
          void (async () => {
            for (const [, ch] of targets) await lockChannel(ch, false, "Anti-raid lockdown expiry");
            guildLockUntil.delete(guild.id);
          })();
        }, lockdownSec * 1000).unref?.();
      }
    }
  }
};

const onReadyCleanup = {
  name: "clientReady" as const,
  run: async () => {
    const started = onReadyCleanup as unknown as { started?: boolean };
    if (started.started) return;
    started.started = true;
    setInterval(() => {
      const now = Date.now();
      for (const [key, list] of spamTracker) {
        const fresh = pruneList(list, 60_000, now);
        if (fresh.length === 0) {
          spamTracker.delete(key);
          spamStrikes.delete(key);
        } else {
          spamTracker.set(key, fresh);
        }
      }
      for (const [key, list] of joinTracker) {
        const fresh = pruneList(list, 120_000, now);
        if (fresh.length === 0) joinTracker.delete(key);
        else joinTracker.set(key, fresh);
      }
    }, 60_000);
  },
};

export const securityModule: Module = {
  name: "security",
  description: "Anti-spam, anti-raid, anti-link, bot protection and lockdown",
  defaultEnabled: true,
  commands: [securityCommand],
  events: [
    { name: "messageCreate", run: onMessageCreate },
    { name: "guildMemberAdd", run: onGuildMemberAdd },
    onReadyCleanup,
  ],
};
