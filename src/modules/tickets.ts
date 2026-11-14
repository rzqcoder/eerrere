import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
} from "discord.js";
import { config } from "../core/config";
import { hasAccessRole } from "../core/guards";
import { getGuildConfig, invalidateGuildConfig } from "../db/guildConfig";
import { GuildConfig, Ticket } from "../db/models";
import { EPHEMERAL, makeEmbed, safeReply } from "../core/util";
import type { Client } from "discord.js";
import type { ComponentPayload, Module, ModuleCommand } from "../core/types";

const MAX_OPEN_PER_USER = 2;

async function openControlRow(
  channel: { id: string },
): Promise<ActionRowBuilder<ButtonBuilder>> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`tickets:claim:${channel.id}`).setLabel("Claim").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tickets:close:${channel.id}`).setLabel("Close").setStyle(ButtonStyle.Danger),
  );
}

async function isTicketStaff(client: Client, interaction: ButtonInteraction, cfg: any): Promise<boolean> {
  const staffIds: string[] = cfg?.tickets?.staffRoleIds ?? [];
  if (!interaction.inCachedGuild()) return false;
  const member = interaction.member;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  if (member.roles.cache.some((r) => staffIds.includes(r.id))) return true;
  void client;
  return hasAccessRole(interaction);
}

const ticketCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("ticket")
    .setDescription("Ticket system")
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("Save ticket configuration")
        .addChannelOption((opt) =>
          opt.setName("category").setDescription("Category new tickets are created in").setRequired(true).addChannelTypes(ChannelType.GuildCategory),
        )
        .addRoleOption((opt) => opt.setName("staff_role").setDescription("Role can claim/admin tickets").setRequired(true))
        .addChannelOption((opt) =>
          opt
            .setName("transcript_channel")
            .setDescription("Where ticket transcripts are saved")
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("panel")
        .setDescription("Post the ticket panel here")
        .addStringOption((opt) => opt.setName("description").setDescription("Panel text")),
    ),
  run: async (_client, interaction) => {
    await interaction.deferReply({ flags: EPHEMERAL });
    const guildId = interaction.guildId;
    if (!guildId) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "setup") {
      const category = interaction.options.getChannel("category", true);
      const staffRole = interaction.options.getRole("staff_role", true);
      const transcriptChannel = interaction.options.getChannel("transcript_channel");
      await GuildConfig.updateOne(
        { guildId },
        { $set: { tickets: { categoryId: category.id, staffRoleIds: [staffRole.id], transcriptChannelId: transcriptChannel?.id ?? undefined } } },
        { upsert: true },
      );
      invalidateGuildConfig(guildId);
      await interaction.editReply("✅ Ticket configuration saved.");
      return;
    }

    if (sub === "panel") {
      const description = interaction.options.getString("description") ?? "Click below to open a private support ticket.";
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId("tickets:open").setLabel("🎫 Open a ticket").setStyle(ButtonStyle.Primary),
      );
      const embed = makeEmbed(config.embedColors.primary)
        .setTitle("Support tickets")
        .setDescription(description);
      if (interaction.channel && "send" in interaction.channel) {
        await (interaction.channel as any).send({ embeds: [embed], components: [row] }).catch(() => undefined);
      }
      await interaction.editReply("Panel posted.");
      return;
    }
  },
};

/* -------------------------------------- buttons -------------------------------------- */

const onOpenTicket = async (client: Client, interaction: ComponentPayload): Promise<void> => {
  if (!interaction.isButton()) return;
  const guild = interaction.guild;
  if (!guild) return;
  const cfg = await getGuildConfig(guild.id);
  const tickets = cfg.tickets;
  if (!tickets?.categoryId) {
    await safeReply(interaction, "Tickets are not configured yet — run `/ticket setup` first.");
    return;
  }
  const category = await guild.channels.fetch(tickets.categoryId).catch(() => null);
  if (!category) {
    await safeReply(interaction, "The configured ticket category is missing — re-run `/ticket setup`.");
    return;
  }
  const openCount = await Ticket.countDocuments({ guildId: guild.id, ownerId: interaction.user.id, status: "open" });
  if (openCount >= MAX_OPEN_PER_USER) {
    await safeReply(interaction, `You already have ${MAX_OPEN_PER_USER} open tickets.`);
    return;
  }
  const existing = await Ticket.findOne({ guildId: guild.id, ownerId: interaction.user.id, status: "open" }).sort({ number: 1 });
  if (existing) {
    await safeReply(interaction, `You already have an open ticket: <#${existing.channelId}>`);
    return;
  }
  const configDoc = await GuildConfig.findOneAndUpdate(
    { guildId: guild.id },
    { $inc: { "tickets.nextNumber": 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  const number = configDoc.tickets?.nextNumber ?? 1;
  const staffIds = tickets.staffRoleIds ?? [];

  const channel = await guild.channels
    .create({
      name: `ticket-${String(number).padStart(4, "0")}`,
      type: ChannelType.GuildText,
      parent: tickets.categoryId,
      topic: `Ticket from ${interaction.user.tag} — /ticket numbering #${number}`,
      permissionOverwrites: [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: interaction.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
        ...staffIds.map((id) => ({
          id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        })),
        { id: interaction.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
      ],
    })
    .catch(() => null);

  if (!channel) {
    await safeReply(interaction, "I couldn't create the ticket channel (missing permissions?).");
    return;
  }
  await Ticket.create({
    guildId: guild.id,
    number,
    channelId: channel.id,
    ownerId: interaction.user.id,
    status: "open",
    createdAt: new Date(),
  });
  const welcome = makeEmbed(config.embedColors.primary)
    .setTitle(`Ticket #${number}`)
    .setDescription(`Welcome <@${interaction.user.id}>! Staff will be with you shortly.\nUse the **Close** button when your issue is resolved.`);
  await channel.send({
    content: `<@${interaction.user.id}>${staffIds.map((id) => `<@&${id}>`).join(" ")}`,
    embeds: [welcome],
    components: [await openControlRow(channel as { id: string })],
  });
  await interaction.reply({ content: `🎟 Ticket created — go to <#${channel.id}>.`, flags: EPHEMERAL });
};

const onClaimTicket = async (client: Client, interaction: ComponentPayload): Promise<void> => {
  if (!interaction.isButton()) return;
  const channelId = interaction.channelId;
  const doc = await Ticket.findOne({ guildId: interaction.guildId, channelId, status: "open" });
  if (!doc) return;
  if (doc.claimedBy) {
    await safeReply(interaction, `Already claimed by <@${doc.claimedBy}>.`);
    return;
  }
  const cfg = await getGuildConfig(interaction.guildId!);
  if (!(await isTicketStaff(client, interaction, cfg)) && doc.ownerId !== interaction.user.id) {
    await safeReply(interaction, "Only staff can claim this ticket.");
    return;
  }
  await Ticket.updateOne({ _id: doc._id }, { $set: { claimedBy: interaction.user.id } });
  await interaction.reply({ content: `📋 <@${interaction.user.id}> claimed this ticket.`, allowedMentions: { users: [] } });
};

const onCloseTicket = async (client: Client, interaction: ComponentPayload): Promise<void> => {
  if (!interaction.isButton()) return;
  const guildId = interaction.guildId!;
  const channelId = interaction.channelId;
  const doc = await Ticket.findOne({ guildId, channelId, status: "open" });
  if (!doc) {
    await safeReply(interaction, "This ticket is not open.");
    return;
  }
  const cfg = await getGuildConfig(guildId);
  const staff = await isTicketStaff(client, interaction, cfg);
  if (!staff && doc.ownerId !== interaction.user.id) {
    await safeReply(interaction, "Only the ticket owner or staff can close this ticket.");
    return;
  }
  await Ticket.updateOne({ _id: doc._id }, { $set: { status: "closed", closedBy: interaction.user.id, closedAt: new Date() } });

  let transcriptNote = "Transcripts unavailable.";
  try {
    const transcripts = await import("discord-html-transcripts");
    if ("isTextBased" in (interaction.channel ?? {}) && interaction.channel?.isTextBased()) {
      const attachment = await transcripts.createTranscript(interaction.channel as any, {
        filename: `ticket-${doc.number}.html`,
      });
      const logChannelId = cfg.tickets?.transcriptChannelId;
      if (logChannelId) {
        const logChannel = await client.channels.fetch(logChannelId).catch(() => null);
        if (logChannel && "send" in logChannel) {
          await (logChannel as any).send({
            content: `ℹ️ Ticket **#${doc.number}** from <@${doc.ownerId}> closed by <@${interaction.user.id}>`,
            files: [attachment],
          });
          transcriptNote = "Transcript saved to the log channel.";
        }
      }
    }
  } catch (err) {
    console.error("[tickets] transcript failed", err);
  }

  await interaction.reply({
    content: `Closing ticket in 15 seconds. ${transcriptNote}`,
    flags: MessageFlags.Ephemeral,
  });
  setTimeout(() => {
    void (interaction.channel as any)?.delete?.(`Ticket #${doc.number} closed by ${interaction.user.tag}`).catch(() => undefined);
  }, 15_000);
};

export const ticketsModule: Module = {
  name: "tickets",
  description: "Ticket panels with claiming and transcripts",
  defaultEnabled: true,
  commands: [ticketCommand],
  interactions: [
    { customId: "tickets:open", public: true, run: onOpenTicket },
    { customId: "tickets:claim", public: false, run: onClaimTicket },
    { customId: "tickets:close", public: true, run: onCloseTicket },
  ],
};

