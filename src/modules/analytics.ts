import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { config } from "../core/config";
import { CommandStat, UserStats, type IUserStats } from "../db/models";
import { EPHEMERAL, makeEmbed, formatDuration, toLocale } from "../core/util";
import type { Module, ModuleCommand } from "../core/types";

/* -------------------------------------- events --------------------------------------- */

interface VoiceMessageStub {
  guildId: string | null;
  guild: { id: string } | null;
  author: { bot: boolean; id: string };
}

const onMessageCreate = async (client: unknown, message: VoiceMessageStub): Promise<void> => {
  try {
    if (!message.guildId || message.author.bot) return;
    await UserStats.updateOne(
      { guildId: message.guildId, userId: message.author.id },
      { $inc: { messages: 1 }, $set: { lastMessageAt: new Date() } },
      { upsert: true, setDefaultsOnInsert: true },
    );
  } catch (err) {
    console.error("[analytics] message stat failed", err);
  }
};

const onVoiceStateUpdate = async (client: unknown, oldState: any, newState: any): Promise<void> => {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot || !(oldState.guildId && newState.guildId)) return;
  const guildId = newState.guildId;
  try {
    if (!oldState.channelId && newState.channelId) {
      await UserStats.updateOne(
        { guildId, userId: member.id },
        { $set: { lastVoiceJoinAt: new Date() } },
        { upsert: true, setDefaultsOnInsert: true },
      );
    } else if (oldState.channelId && !newState.channelId) {
      await flushVoiceMinutes(guildId, member.id);
    } else if (oldState.channelId !== newState.channelId) {
      await flushVoiceMinutes(guildId, member.id);
      await UserStats.updateOne(
        { guildId, userId: member.id },
        { $set: { lastVoiceJoinAt: new Date() } },
        { upsert: true, setDefaultsOnInsert: true },
      );
    }
  } catch (err) {
    console.error("[analytics] voice stat failed", err);
  }
};

async function flushVoiceMinutes(guildId: string, userId: string): Promise<void> {
  const doc = await UserStats.findOne({ guildId, userId });
  if (!doc?.lastVoiceJoinAt) return;
  const minutes = Math.max(0, Math.round((Date.now() - doc.lastVoiceJoinAt.getTime()) / 60_000));
  await UserStats.updateOne(
    { guildId, userId },
    { $inc: { voiceMinutes: minutes }, $set: { lastVoiceJoinAt: null } },
  );
}

/* ------------------------------------- commands -------------------------------------- */

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h ${rest}m`;
}

const topCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("top")
    .setDescription("Server leaderboards")
    .addSubcommand((sub) =>
      sub
        .setName("messages")
        .setDescription("Most active members by messages")
        .addIntegerOption((opt) => opt.setName("limit").setDescription("Entries (5-25, default 10)").setMinValue(1).setMaxValue(25)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("voice")
        .setDescription("Most active members by voice time")
        .addIntegerOption((opt) => opt.setName("limit").setDescription("Entries (5-25, default 10)").setMinValue(1).setMaxValue(25)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("commands")
        .setDescription("Most-used commands")
        .addIntegerOption((opt) => opt.setName("limit").setDescription("Entries (5-25, default 10)").setMinValue(1).setMaxValue(25)),
    ),
  run: async (_client, interaction) => {
    await interaction.deferReply({ flags: EPHEMERAL });
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();
    const limit = interaction.options.getInteger("limit") ?? 10;

    if (sub === "commands") {
      const rows = await CommandStat.aggregate([
        { $match: { guildId } },
        { $group: { _id: "$commandName", total: { $sum: "$count" } } },
        { $sort: { total: -1 } },
        { $limit: limit },
      ]);
      if (rows.length === 0) {
        await interaction.editReply("No command usage recorded yet.");
        return;
      }
      const lines = rows.map((r: { _id: string; total: number }, i: number) => `${i + 1}. \`/${r._id}\` — ${toLocale(r.total)} uses`);
      const embed = makeEmbed(config.embedColors.primary).setTitle("📊 Top commands").setDescription(lines.join("\n"));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const field = sub === "voice" ? "voiceMinutes" : "messages";
    const docs = await UserStats.find({ guildId }).sort({ [field]: -1 }).limit(limit);
    if (docs.length === 0) {
      await interaction.editReply("No stats recorded yet.");
      return;
    }
    const lines = docs.map((doc: IUserStats, i: number) => {
      const value = field === "voiceMinutes" ? formatMinutes(doc.voiceMinutes) : toLocale(doc.messages);
      return `${i + 1}. <@${doc.userId}> — ${value}`;
    });
    const embed = makeEmbed(config.embedColors.primary)
      .setTitle(sub === "voice" ? "📊 Top voice time" : "📊 Top messages")
      .setDescription(lines.join("\n"));
    await interaction.editReply({ embeds: [embed] });
  },
};

const statsCommand: ModuleCommand = {
  data: new SlashCommandBuilder().setName("stats").setDescription("Show your own activity stats").setDMPermission(false),
  public: true,
  run: async (_client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const doc = await UserStats.findOne({ guildId: interaction.guildId, userId: interaction.user.id });
    if (!doc) {
      await interaction.editReply("No stats yet — say something!");
      return;
    }
    const embed = makeEmbed(config.embedColors.primary)
      .setTitle("📊 Your stats")
      .setDescription(
        [
          `**Messages:** ${toLocale(doc.messages)}`,
          `**Voice time:** ${formatDuration(doc.voiceMinutes * 60_000)}`,
          doc.lastMessageAt ? `**Last message:** <t:${Math.floor(doc.lastMessageAt.getTime() / 1000)}:R>` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    await interaction.editReply({ embeds: [embed] });
  },
};

export const analyticsModule: Module = {
  name: "analytics",
  description: "Message/voice leaderboards and stats",
  defaultEnabled: true,
  commands: [topCommand, statsCommand],
  events: [
    { name: "messageCreate", run: onMessageCreate },
    { name: "voiceStateUpdate", run: onVoiceStateUpdate },
  ],
};
