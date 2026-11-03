import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  ChannelType,
  type TextChannel,
} from "discord.js";
import { config } from "../core/config";
import { getGuildConfig } from "../db/guildConfig";
import { GuildConfig, ModCase, type IModCase } from "../db/models";
import { invalidateGuildConfig } from "../db/guildConfig";
import { EPHEMERAL, makeEmbed, parseDuration, formatDuration, truncate } from "../core/util";
import type { Module, ModuleCommand } from "../core/types";

const CASE_TYPES = ["ban", "unban", "kick", "timeout", "untimeout", "warn"] as const;
type CaseType = (typeof CASE_TYPES)[number];

function caseEmbed(inc: IModCase): EmbedBuilder {
  return makeEmbed(config.embedColors.primary)
    .setTitle(`Case #${inc.caseId} — ${inc.type}`)
    .setDescription(
      [
        `**Target:** <@${inc.targetUserId}> (${inc.targetTag ?? "unknown"})`,
        `**Moderator:** <@${inc.moderatorId}>`,
        inc.reason ? `**Reason:** ${truncate(inc.reason, 1024)}` : null,
        inc.durationMs ? `**Duration:** ${formatDuration(inc.durationMs)}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .setTimestamp(inc.createdAt);
}

async function logCase(client: any, guildId: string, inc: IModCase): Promise<void> {
  const cfg = await getGuildConfig(guildId);
  const channelId = cfg.logChannels?.get("moderation");
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !("send" in channel)) return;
  await (channel as TextChannel).send({ embeds: [caseEmbed(inc)] }).catch(() => undefined);
}

async function nextCaseId(guildId: string): Promise<number> {
  const doc = await GuildConfig.findOneAndUpdate(
    { guildId },
    { $inc: { nextCaseNumber: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  invalidateGuildConfig(guildId);
  return doc.nextCaseNumber ?? 1;
}

async function createCase(
  client: any,
  guildId: string,
  type: CaseType,
  moderatorId: string,
  targetUserId: string,
  targetTag: string | undefined,
  reason: string | undefined,
  durationMs?: number,
): Promise<IModCase> {
  const caseId = await nextCaseId(guildId);
  const doc = await ModCase.create({
    guildId,
    caseId,
    type,
    targetUserId,
    targetTag,
    moderatorId,
    reason,
    durationMs,
    createdAt: new Date(),
  });
  await logCase(client, guildId, doc);
  return doc;
}

function parseTargetUser(interact: any): { id: string; tag: string } {
  const user = interact.options.getUser("user", true);
  return { id: user.id, tag: user.tag };
}

const modCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("mod")
    .setDescription("Moderation actions")
    .addSubcommand((sub) =>
      sub
        .setName("ban")
        .setDescription("Ban a member")
        .addUserOption((opt) => opt.setName("user").setDescription("Member to ban").setRequired(true))
        .addStringOption((opt) => opt.setName("reason").setDescription("Reason").setRequired(false))
        .addIntegerOption((opt) =>
          opt.setName("days").setDescription("Delete message history in days (0-7)").setMinValue(0).setMaxValue(7),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("unban")
        .setDescription("Unban a user by ID")
        .addStringOption((opt) => opt.setName("user_id").setDescription("Discord user ID").setRequired(true))
        .addStringOption((opt) => opt.setName("reason").setDescription("Reason")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("kick")
        .setDescription("Kick a member")
        .addUserOption((opt) => opt.setName("user").setDescription("Member to kick").setRequired(true))
        .addStringOption((opt) => opt.setName("reason").setDescription("Reason")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("timeout")
        .setDescription("Timeout a member (e.g. 10m, 2h)")
        .addUserOption((opt) => opt.setName("user").setDescription("Member to timeout").setRequired(true))
        .addStringOption((opt) => opt.setName("duration").setDescription("Duration like 10m / 2h / 1d").setRequired(true))
        .addStringOption((opt) => opt.setName("reason").setDescription("Reason")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("untimeout")
        .setDescription("Remove a member's timeout")
        .addUserOption((opt) => opt.setName("user").setDescription("Member").setRequired(true))
        .addStringOption((opt) => opt.setName("reason").setDescription("Reason")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("warn")
        .setDescription("Warn a member (creates a case)")
        .addUserOption((opt) => opt.setName("user").setDescription("Member to warn").setRequired(true))
        .addStringOption((opt) => opt.setName("reason").setDescription("Reason").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("case")
        .setDescription("View one case")
        .addIntegerOption((opt) => opt.setName("id").setDescription("Case number").setRequired(true).setMinValue(1)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("cases")
        .setDescription("List recent cases")
        .addUserOption((opt) => opt.setName("user").setDescription("Filter by user")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("purge")
        .setDescription("Bulk delete recent messages")
        .addIntegerOption((opt) => opt.setName("amount").setDescription("1-100").setRequired(true).setMinValue(1).setMaxValue(100)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("slowmode")
        .setDescription("Set channel slowmode")
        .addIntegerOption((opt) =>
          opt.setName("seconds").setDescription("0 to disable").setRequired(true).setMinValue(0).setMaxValue(21600),
        ),
    ),
  run: async (client, interaction) => {
    await interaction.deferReply({ flags: EPHEMERAL });
    const guild = interaction.guild;
    if (!guild) return;
    const sub = interaction.options.getSubcommand();

    const replyCase = async (inc: IModCase, note: string) => {
      const embed = caseEmbed(inc).setFooter({ text: note });
      await interaction.editReply({ embeds: [embed] });
    };

    if (sub === "ban") {
      const target = parseTargetUser(interaction);
      const reason = interaction.options.getString("reason") ?? "No reason provided";
      const days = interaction.options.getInteger("days") ?? 0;
      const seconds = Math.min(Math.max(days, 0), 7) * 86400;
      await guild.members.ban(target.id, { reason, deleteMessageSeconds: seconds });
      const doc = await createCase(client, guild.id, "ban", interaction.user.id, target.id, target.tag, reason);
      await replyCase(doc, "This member was banned.");
      return;
    }

    if (sub === "unban") {
      const userId = interaction.options.getString("user_id", true);
      const reason = interaction.options.getString("reason") ?? "No reason provided";
      await guild.members.unban(userId, reason).catch((err) => {
        throw new Error(`Could not unban \`${userId}\`: ${err?.message ?? err}`);
      });
      const doc = await createCase(client, guild.id, "unban", interaction.user.id, userId, undefined, reason);
      await replyCase(doc, "This user was unbanned.");
      return;
    }

    if (sub === "kick" || sub === "timeout" || sub === "untimeout") {
      const target = parseTargetUser(interaction);
      const member = await guild.members.fetch(target.id).catch(() => null);
      if (!member) throw new Error("That member is not in this server.");
      if (!member.moderatable) {
        throw new Error("I cannot moderate that member (role hierarchy or permissions).");
      }
      const reason = interaction.options.getString("reason") ?? "No reason provided";
      if (sub === "kick") {
        await member.kick(reason);
        const doc = await createCase(client, guild.id, "kick", interaction.user.id, target.id, target.tag, reason);
        await replyCase(doc, "This member was kicked.");
        return;
      }
      if (sub === "timeout") {
        const ms = parseDuration(interaction.options.getString("duration", true));
        if (!ms || ms < 5000) throw new Error("Invalid duration. Try formats like `10m`, `2h`, `1d`.");
        if (ms > 28 * 86400 * 1000) throw new Error("Timeout is limited to 28 days.");
        await member.timeout(ms, reason);
        const doc = await createCase(
          client,
          guild.id,
          "timeout",
          interaction.user.id,
          target.id,
          target.tag,
          reason,
          ms,
        );
        await replyCase(doc, `This member was timed out for ${formatDuration(ms)}.`);
        return;
      }
      await member.timeout(null, reason);
      const doc = await createCase(client, guild.id, "untimeout", interaction.user.id, target.id, target.tag, reason);
      await replyCase(doc, "This member's timeout was removed.");
      return;
    }

    if (sub === "warn") {
      const target = parseTargetUser(interaction);
      const reason = interaction.options.getString("reason", true);
      const doc = await createCase(client, guild.id, "warn", interaction.user.id, target.id, target.tag, reason);
      await dmWarn(target.id, config.name, reason);
      await replyCase(doc, "This member was warned.");
      return;
    }

    if (sub === "case") {
      const id = interaction.options.getInteger("id", true);
      const doc = await ModCase.findOne({ guildId: guild.id, caseId: id });
      if (!doc) throw new Error(`Case #${id} not found.`);
      await interaction.editReply({ embeds: [caseEmbed(doc)] });
      return;
    }

    if (sub === "cases") {
      const user = interaction.options.getUser("user");
      const filter: Record<string, unknown> = { guildId: guild.id };
      if (user) filter.targetUserId = user.id;
      const docs = await ModCase.find(filter).sort({ caseId: -1 }).limit(10);
      if (docs.length === 0) {
        await interaction.editReply("No cases found.");
        return;
      }
      const lines = docs.map(
        (d) =>
          `\`#${d.caseId}\` **${d.type}** — <@${d.targetUserId}> by <@${d.moderatorId}> <t:${Math.floor(
            (d.createdAt?.getTime() ?? 0) / 1000,
          )}:R>`,
      );
      const embed = new EmbedBuilder()
        .setColor(config.embedColors.primary)
        .setTitle(`Recent cases — ${guild.name}`)
        .setDescription(lines.join("\n"));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "purge") {
      const amount = interaction.options.getInteger("amount", true);
      if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
        throw new Error("This command can only be used in a text channel.");
      }
      const channel = interaction.channel as TextChannel;
      const deleted = await channel.bulkDelete(amount, true).catch(() => null);
      if (deleted === null) {
        await interaction.editReply("Could not purge (messages may be older than 14 days or missing permissions).");
        return;
      }
      await interaction.editReply(`🧹 Deleted **${deleted.size}** messages.`);
      setTimeout(() => interaction.deleteReply().catch(() => undefined), 5000);
      return;
    }

    if (sub === "slowmode") {
      const seconds = interaction.options.getInteger("seconds", true);
      if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
        throw new Error("This command can only be used in a text channel.");
      }
      await (interaction.channel as TextChannel).setRateLimitPerUser(seconds);
      await interaction.editReply(seconds === 0 ? "⏱ Slowmode disabled." : `⏱ Slowmode set to **${seconds}s**.`);
      return;
    }
  },
};

async function dmWarn(userId: string, botName: string, reason: string): Promise<void> {
  try {
    const client = (await import("../core/client")).client;
    const user = await client.users.fetch(userId);
    await user.send(`⚠️ You were warned in **${botName}**.\nReason: ${truncate(reason, 1024)}`);
  } catch {
    // user may have DMs closed – fine
  }
}

export const moderationModule: Module = {
  name: "moderation",
  description: "Bans, kicks, timeouts, warnings, cases and purge",
  defaultEnabled: true,
  commands: [modCommand],
};
