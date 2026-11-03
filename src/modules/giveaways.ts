import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type Client,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import { config } from "../core/config";
import { Giveaway, type IGiveaway } from "../db/models";
import { EPHEMERAL, makeEmbed, parseDuration, pickRandom, relTime, truncate } from "../core/util";
import type { Module, ModuleCommand } from "../core/types";

const GIVEAWAY_EMOJI = "🎉";
let sweepStarted = false;

async function fetchGiveawayMessage(client: Client, doc: IGiveaway): Promise<Message | null> {
  const channel = await client.channels.fetch(doc.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !("messages" in channel)) return null;
  const message = await (channel as TextBasedChannel).messages.fetch(doc.messageId).catch(() => null);
  return message as Message | null;
}

async function collectEntries(doc: IGiveaway, message: Message | null): Promise<string[]> {
  if (!message) return doc.winners.length ? doc.participants : [];
  const reaction = message.reactions.cache.get(GIVEAWAY_EMOJI);
  if (!reaction) return doc.winners.length ? doc.participants : [];
  const users = await reaction.users.fetch().catch(() => null);
  if (!users) return doc.winners.length ? doc.participants : [];
  const ids: string[] = [];
  for (const [, user] of users) if (!user.bot) ids.push(user.id);
  return ids;
}

async function endGiveaway(client: Client, doc: IGiveaway): Promise<void> {
  if (doc.status === "ended") return;
  const message = await fetchGiveawayMessage(client, doc);
  if (!message) {
    // giveaway message is gone; close without winners
    doc.status = "ended";
    doc.endedAt = new Date();
    await Giveaway.updateOne({ _id: doc._id }, { $set: { status: "ended", endedAt: new Date() } });
    return;
  }

  const entries = await collectEntries(doc, message);
  await Giveaway.updateOne({ _id: doc._id }, { $set: { participants: entries } });
  const pool = entries.filter((id) => !(doc.winners ?? []).includes(id));
  const winners = pickRandom(pool, doc.winnerCount);

  await Giveaway.updateOne(
    { _id: doc._id },
    { $set: { status: "ended", endedAt: new Date(), winners: [...(doc.winners ?? []), ...winners] } },
  );

  const hasWinner = winners.length > 0;
  const resultEmbed = makeEmbed(config.embedColors.success)
    .setTitle(`${GIVEAWAY_EMOJI} Giveaway ended`)
    .setDescription(
      [
        `**Prize:** ${doc.prize}`,
        `**Winners:** ${hasWinner ? winners.map((id) => `<@${id}>`).join(", ") : "No valid entries 😢"}`,
        `**Entries:** ${entries.length}`,
      ].join("\n"),
    );
  await message
    .reply({ content: hasWinner ? winners.map((id) => `<@${id}>`).join(" ") : `${GIVEAWAY_EMOJI}`, embeds: [resultEmbed] })
    .catch(() => undefined);
  const base = message.embeds[0];
  if (base) {
    await message
      .edit({
        embeds: [
          EmbedBuilder.from(base)
            .setColor(config.embedColors.danger)
            .setFooter({ text: "Ended" })
            .setDescription((base.description ?? "").replace(/Ends:.*$/m, "Ended")),
        ],
      })
      .catch(() => undefined);
  }
}

const sweepReadyEvent = {
  name: "clientReady" as const,
  run: async (client: Client): Promise<void> => {
    if (sweepStarted) return;
    sweepStarted = true;
    const sweep = async () => {
      try {
        const due = await Giveaway.find({ status: "open", endsAt: { $lte: new Date() } });
        for (const doc of due) await endGiveaway(client, doc);
      } catch (err) {
        console.error("[giveaways] sweep failed", err);
      }
    };
    await sweep();
    setInterval(() => {
      void sweep();
    }, 30_000);
  },
};

const giveawayCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("giveaway")
    .setDescription("Manage reaction giveaways")
    .addSubcommand((sub) =>
      sub
        .setName("start")
        .setDescription("Start a giveaway")
        .addStringOption((opt) => opt.setName("duration").setDescription("e.g. 10m, 2h, 1d").setRequired(true))
        .addIntegerOption((opt) => opt.setName("winners").setDescription("How many winners").setRequired(true).setMinValue(1).setMaxValue(20))
        .addStringOption((opt) => opt.setName("prize").setDescription("What is being given away").setRequired(true))
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to post in (default here)")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("end")
        .setDescription("End a running giveaway now")
        .addStringOption((opt) => opt.setName("message_id").setDescription("Giveaway message ID").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("reroll")
        .setDescription("Draw another winner from an ended giveaway")
        .addStringOption((opt) => opt.setName("message_id").setDescription("Giveaway message ID").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List recent giveaways")),
  run: async (client, interaction) => {
    await interaction.deferReply({ flags: EPHEMERAL });
    const guild = interaction.guild;
    if (!guild) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "start") {
      const ms = parseDuration(interaction.options.getString("duration", true));
      if (ms === null || ms < 10_000) {
        await interaction.editReply("Duration must be at least 10s (formats: `10m`, `2h`, `1d`).");
        return;
      }
      const winners = interaction.options.getInteger("winners", true);
      const prize = interaction.options.getString("prize", true).slice(0, 180);
      const channelOpt = interaction.options.getChannel("channel");
      const channel = channelOpt ?? interaction.channel;
      if (!channel || !("send" in channel)) {
        await interaction.editReply("I can't post in that channel.");
        return;
      }
      const endsAt = new Date(Date.now() + ms);
      const embed = makeEmbed(config.embedColors.success)
        .setTitle(`${GIVEAWAY_EMOJI} Giveaway`)
        .setDescription(
          [
            `**Prize:** ${prize}`,
            `**Winners:** ${winners}`,
            `**Hosted by:** <@${interaction.user.id}>`,
            `**Ends:** ${relTime(endsAt)}`,
            "",
            `React with ${GIVEAWAY_EMOJI} to enter!`,
          ].join("\n"),
        )
        .setTimestamp(endsAt);
      const message = await channel
        .send({ embeds: [embed], content: GIVEAWAY_EMOJI })
        .catch(() => null);
      if (!message) {
        await interaction.editReply("I couldn't post the giveaway (missing permissions?).");
        return;
      }
      await message.react(GIVEAWAY_EMOJI).catch(() => undefined);
      await Giveaway.create({
        guildId: guild.id,
        channelId: channel.id,
        messageId: message.id,
        hostId: interaction.user.id,
        prize,
        winnerCount: winners,
        participants: [],
        winners: [],
        status: "open",
        endsAt,
        createdAt: new Date(),
      });
      await interaction.editReply(`Giveaway started: ${message.url}`);
      return;
    }

    if (sub === "end") {
      const messageId = interaction.options.getString("message_id", true);
      const doc = await Giveaway.findOne({ guildId: guild.id, messageId, status: "open" });
      if (!doc) {
        await interaction.editReply("No open giveaway with that message ID (use `/giveaway list`).");
        return;
      }
      await endGiveaway(client, doc);
      await interaction.editReply("Giveaway ended and winners were announced.");
      return;
    }

    if (sub === "reroll") {
      const messageId = interaction.options.getString("message_id", true);
      const doc = await Giveaway.findOne({ guildId: guild.id, messageId, status: "ended" });
      if (!doc) {
        await interaction.editReply("No ended giveaway with that message ID.");
        return;
      }
      const message = await fetchGiveawayMessage(client, doc);
      const entries = await collectEntries(doc, message);
      const pool = entries.filter((id) => !doc.winners.includes(id));
      if (pool.length === 0) {
        await interaction.editReply("Every eligible participant already won.");
        return;
      }
      const [winner] = pickRandom(pool, 1);
      await Giveaway.updateOne({ _id: doc._id }, { $push: { winners: winner! } });
      const embed = makeEmbed(config.embedColors.success)
        .setTitle(`${GIVEAWAY_EMOJI} Giveaway reroll`)
        .setDescription(`**Prize:** ${doc.prize}\n**New winner:** <@${winner}>`);
      const channel = await client.channels.fetch(doc.channelId).catch(() => null);
      if (channel && channel.isTextBased() && "send" in channel) {
        await channel.send({ content: `<@${winner}>`, embeds: [embed] }).catch(() => undefined);
      }
      await interaction.editReply(`Rerolled — new winner <@${winner}>.`);
      return;
    }

    if (sub === "list") {
      const docs = await Giveaway.find({ guildId: guild.id }).sort({ createdAt: -1 }).limit(10);
      if (docs.length === 0) {
        await interaction.editReply("No giveaways yet.");
        return;
      }
      const lines = docs.map((d) => {
        const state = d.status === "open" ? `ends ${relTime(d.endsAt)}` : `ended ${relTime(d.endedAt ?? d.endsAt)}`;
        return `- \`← ${d.messageId}\` **${truncate(d.prize, 60)}** — ${state} — winners: ${d.winners.length}/${d.winnerCount}`;
      });
      const embed = new EmbedBuilder()
        .setColor(config.embedColors.primary)
        .setTitle("Recent giveaways")
        .setDescription(lines.join("\n"));
      await interaction.editReply({ embeds: [embed] });
      return;
    }
  },
};

export const giveawaysModule: Module = {
  name: "giveaways",
  description: "Reaction-based giveaways",
  defaultEnabled: true,
  commands: [giveawayCommand],
  events: [sweepReadyEvent],
};
