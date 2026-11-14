import {
  ActionRowBuilder,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { config } from "../core/config";
import { EPHEMERAL } from "../core/util";
import type { Module, ModuleCommand, ModuleInteraction, ComponentPayload } from "../core/types";
import type { Client } from "discord.js";

const embedBuilderCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("embed")
    .setDescription("Build and send a rich embed")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Channel to post in (default: here)")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  run: async (_client, interaction) => {
    const targetChannel = interaction.options.getChannel("channel");
    if (targetChannel && !("send" in targetChannel)) {
      await interaction.reply({ content: "I can't post in that channel.", flags: EPHEMERAL });
      return;
    }
    const channelId = targetChannel?.id ?? interaction.channelId;
    const modal = new ModalBuilder()
      .setCustomId(`embeds:submit:${channelId}`)
      .setTitle("Embed builder")
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("title")
            .setLabel("Title")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(256)
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("description")
            .setLabel("Description")
            .setStyle(TextInputStyle.Paragraph)
            .setMaxLength(4000)
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("footer")
            .setLabel("Footer (optional)")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(150)
            .setRequired(false),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("color")
            .setLabel("Hex color, e.g. #5865f2 (optional)")
            .setStyle(TextInputStyle.Short)
            .setMaxLength(7)
            .setRequired(false),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId("image")
            .setLabel("Image URL (optional)")
            .setStyle(TextInputStyle.Short)
            .setRequired(false),
        ),
      );
    await interaction.showModal(modal);
  },
};

const sayCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("say")
    .setDescription("Talk as the bot")
    .addStringOption((opt) =>
      opt.setName("content").setDescription("Message to send").setRequired(true).setMaxLength(2000),
    ),
  run: async (_client, interaction) => {
    const content = interaction.options.getString("content", true);
    const channel = interaction.channel;
    if (channel && "send" in channel) await (channel as any).send(content).catch(() => undefined);
    await interaction.reply({ content: "Message sent.", flags: EPHEMERAL });
  },
};

const embedModal: ModuleInteraction = {
  customId: "embeds:submit",
  run: async (client, interaction) => {
    if (!interaction.isModalSubmit()) return;
    const parts = interaction.customId.split(":");
    const channelId = parts[2] ?? interaction.channelId;
    const title = interaction.fields.getTextInputValue("title");
    const description = interaction.fields.getTextInputValue("description");
    const footer = interaction.fields.getTextInputValue("footer") || null;
    const colorRaw = (interaction.fields.getTextInputValue("color") || "").replace("#", "");
    const image = interaction.fields.getTextInputValue("image") || null;

    let color = config.embedColors.primary;
    if (/^[0-9a-fA-F]{6}$/.test(colorRaw)) color = parseInt(colorRaw, 16);

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(title)
      .setDescription(description);
    if (footer) embed.setFooter({ text: footer });
    if (image && /^https?:\/\//i.test(image)) embed.setImage(image);

    if (channelId === interaction.channelId) {
      const channel = interaction.channel;
      if (channel && "send" in channel) await (channel as any).send({ embeds: [embed] }).catch(() => undefined);
    } else {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel && "send" in channel) {
        await (channel as any).send({ embeds: [embed] }).catch(() => undefined);
      }
    }
    await interaction.reply({ content: "Embed sent.", flags: EPHEMERAL });
  },
};

export const embedsModule: Module = {
  name: "embeds",
  description: "Rich embed builder and announcements",
  defaultEnabled: true,
  commands: [embedBuilderCommand, sayCommand],
  interactions: [embedModal],
};
