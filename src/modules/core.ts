import {
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Guild,
  type StringSelectMenuInteraction,
} from "discord.js";
import { config } from "../core/config";
import { startupAt } from "../core/client";
import { moduleMeta } from "../core/moduleMeta";
import { formatDuration } from "../core/util";
import { GuildConfig } from "../db/models";
import { invalidateGuildConfig } from "../db/guildConfig";
import type { Module, ModuleCommand, ModuleInteraction } from "../core/types";

const pingCommand: ModuleCommand = {
  data: new SlashCommandBuilder().setName("ping").setDescription("Check the bot's latency and uptime"),
  public: true,
  run: async (_client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const start = Date.now();
    const sent = await interaction.editReply("Pinging...");
    const roundTrip = sent?.createdTimestamp ? sent.createdTimestamp - start : Date.now() - start;
    const embed = new EmbedBuilder()
      .setColor(config.embedColors.primary)
      .setDescription(
        `🏓 Pong!\n- Round-trip: **${roundTrip}ms**\n- Websocket: **${interaction.client.ws.ping}ms**\n- Uptime: **${formatDuration(
          Date.now() - startupAt,
        )}**`,
      );
    await interaction.editReply({ content: "", embeds: [embed] });
  },
};

const helpCommand: ModuleCommand = {
  data: new SlashCommandBuilder().setName("help").setDescription("Browse the bot's modules"),
  public: true,
  run: async (_client, interaction) => {
    const totalCommands = moduleMeta.reduce((n, m) => n + m.commands.length, 0);
    const select = new StringSelectMenuBuilder()
      .setCustomId("help:module")
      .setPlaceholder("Pick a module to see its commands")
      .addOptions(
        moduleMeta.map((m) => {
          const option = new StringSelectMenuOptionBuilder().setLabel(m.name).setDescription(m.description.slice(0, 100));
          option.setValue(m.name);
          return option;
        }),
      );
    const embed = new EmbedBuilder()
      .setColor(config.embedColors.primary)
      .setTitle(`${config.name} — Help`)
      .setDescription(
        `${totalCommands} commands across ${moduleMeta.length} modules.\nUse the menu below to browse each module.`,
      );
    await interaction.reply({
      embeds: [embed],
      components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
      flags: MessageFlags.Ephemeral,
    });
  },
};

const infoCommand: ModuleCommand = {
  data: new SlashCommandBuilder().setName("info").setDescription("Show bot and server info"),
  public: true,
  run: async (_client, interaction) => {
    if (!interaction.guild) return;
    const guild = interaction.guild as Guild;
    const embed = new EmbedBuilder()
      .setColor(config.embedColors.primary)
      .setTitle(guild.name)
      .setThumbnail(guild.iconURL())
      .addFields(
        { name: "Members", value: toLocale(guild.memberCount), inline: true },
        { name: "Created", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
        { name: "Owner", value: `<@${guild.ownerId}>`, inline: true },
        { name: "Bot version", value: config.version, inline: true },
      );
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

const modulesCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("modules")
    .setDescription("List, enable or disable bot modules")
    .addSubcommand((sub) => sub.setName("list").setDescription("Show all modules and their state"))
    .addSubcommand((sub) =>
      sub
        .setName("enable")
        .setDescription("Enable a module in this server")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Module to enable")
            .setRequired(true)
            .setChoices(moduleMeta.map((m) => ({ name: m.name, value: m.name }))),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("disable")
        .setDescription("Disable a module in this server")
        .addStringOption((opt) =>
          opt
            .setName("name")
            .setDescription("Module to disable")
            .setRequired(true)
            .setChoices(moduleMeta.map((m) => ({ name: m.name, value: m.name }))),
        ),
    ),
  run: async (_client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    if (!guildId) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "list") {
      const cfg = await GuildConfig.findOne({ guildId });
      const lines = moduleMeta.map((m) => {
        const state = cfg?.enabledModules?.get(m.name) ?? m.defaultEnabled;
        const cmds = m.commands.map((c) => `\`/${c}\``).join(" ");
        return `${state ? "🟢" : "🔴"} **${m.name}** — ${m.description}\n${cmds}`;
      });
      const embed = new EmbedBuilder()
        .setColor(config.embedColors.primary)
        .setTitle("Modules")
        .setDescription(`Use \`/modules enable <name>\` or \`/modules disable <name>\`.\n\n${lines.join("\n\n")}`);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const name = interaction.options.getString("name", true);
    const meta = moduleMeta.find((m) => m.name === name);
    if (!meta) {
      await interaction.editReply(`Unknown module \`${name}\`.`);
      return;
    }
    const enabled = sub === "enable";
    await GuildConfig.updateOne({ guildId }, { $set: { [`enabledModules.${name}`]: enabled } }, { upsert: true });
    invalidateGuildConfig(guildId);
    await interaction.editReply(`${enabled ? "🟢 Enabled" : "🔴 Disabled"} module **${name}**.`);
  },
};

const toLocale = (n: number): string => n.toLocaleString("en-US");

const helpSelect: ModuleInteraction = {
  customId: "help:module",
  public: true,
  run: async (_client, interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    const selected = interaction.values[0];
    const meta = moduleMeta.find((m) => m.name === selected);
    if (!meta) return;
    const embed = new EmbedBuilder()
      .setColor(config.embedColors.primary)
      .setTitle(`Module: ${meta.name}`)
      .setDescription(meta.description)
      .addFields({ name: "Commands", value: meta.commands.map((c) => `\`/${c}\``).join(" ") });
    await interaction.update({ embeds: [embed] });
  },
};

export const coreModule: Module = {
  name: "core",
  description: "Ping, help, info and module management",
  defaultEnabled: true,
  commands: [pingCommand, helpCommand, infoCommand, modulesCommand],
  interactions: [helpSelect],
};

