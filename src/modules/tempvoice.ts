import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  VoiceState,
  type GuildMember,
} from "discord.js";
import { getGuildConfig } from "../db/guildConfig";
import { GuildConfig, TempVoice, type ITempVoice } from "../db/models";
import { invalidateGuildConfig } from "../db/guildConfig";
import { EPHEMERAL } from "../core/util";
import type { Module, ModuleCommand, ModuleInteraction } from "../core/types";
import type { Client } from "discord.js";

let staleChecked = false;

async function findDocForChannel(guildId: string, channelId: string): Promise<ITempVoice | null> {
  return TempVoice.findOne({ guildId, channelId });
}

/* -------------------------------------- events --------------------------------------- */

const onVoiceStateUpdate = async (
  client: Parameters<ModuleInteraction["run"]>[0],
  oldState: VoiceState,
  newState: VoiceState,
): Promise<void> => {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot || !newState.guild) return;
  const guild = newState.guild;
  const cfg = await getGuildConfig(guild.id);
  const joinId = cfg.tempVoice?.joinChannelId;
  if (!joinId) return;

  // deleting emptied temp channels (either side of the transition)
  for (const state of [oldState, newState]) {
    if (!state.channelId || state.channelId === joinId) continue;
    const channel = guild.channels.cache.get(state.channelId);
    if (!channel || !("members" in channel)) continue;
    if ((channel as any).members.size > 0) continue;
    const doc = await findDocForChannel(guild.id, state.channelId);
    if (!doc) continue;
    await TempVoice.deleteOne({ _id: doc._id });
    await channel.delete("Temp voice channel empty").catch(() => undefined);
  }

  // creation
  if (newState.channelId !== joinId) return;
  const template = cfg.tempVoice?.nameTemplate ?? "{user}'s Channel";
  const name = template.replaceAll("{user}", member.user.username).slice(0, 90);
  const category = cfg.tempVoice?.categoryId ?? undefined;
  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildVoice,
    parent: category,
    permissionOverwrites: [
      {
        id: member.id,
        allow: [
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.MoveMembers,
          PermissionFlagsBits.MuteMembers,
          PermissionFlagsBits.DeafenMembers,
        ],
      },
    ],
  });
  await TempVoice.create({ guildId: guild.id, channelId: channel.id, ownerId: member.id, createdAt: new Date() });
  await member.voice.setChannel(channel).catch(() => undefined);
};

/* ------------------------------------- commands -------------------------------------- */

async function currentTempDoc(interaction: any): Promise<{ doc: ITempVoice; channel: any } | null> {
  const member: GuildMember | null = interaction.member;
  if (!member) return null;
  const voiceChannel = member.voice.channel;
  if (!voiceChannel || voiceChannel.guild.id !== interaction.guildId) return null;
  const doc = await findDocForChannel(interaction.guildId, voiceChannel.id);
  if (!doc) return null;
  return { doc, channel: voiceChannel };
}

const vcCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("vc")
    .setDescription("Join-to-create voice channels")
    .addSubcommand((sub) =>
      sub
        .setName("setup")
        .setDescription("Create a Join-to-Create channel in a category")
        .addChannelOption((opt) =>
          opt.setName("category").setDescription("Category for new temp channels").setRequired(true).addChannelTypes(ChannelType.GuildCategory),
        )
        .addStringOption((opt) =>
          opt.setName("template").setDescription('Name template, `{user}` is the joiner (default "{user} Channel")'),
        ),
    )
    .addSubcommand((sub) => sub.setName("claim").setDescription("Claim the temp channel you're in"))
    .addSubcommand((sub) => sub.setName("lock").setDescription("Lock your temp channel"))
    .addSubcommand((sub) => sub.setName("unlock").setDescription("Unlock your temp channel"))
    .addSubcommand((sub) =>
      sub
        .setName("permit")
        .setDescription("Allow a specific user into your temp channel")
        .addUserOption((opt) => opt.setName("user").setDescription("User to allow").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("deny")
        .setDescription("Deny a user and kick them from your temp channel")
        .addUserOption((opt) => opt.setName("user").setDescription("User to deny").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("name")
        .setDescription("Rename your temp channel")
        .addStringOption((opt) => opt.setName("name").setDescription("New channel name").setRequired(true)),
    ),
  run: async (client, interaction) => {
    await interaction.deferReply({ flags: EPHEMERAL });
    const guildId = interaction.guildId;
    if (!guildId) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "setup") {
      const category = interaction.options.getChannel("category", true);
      const template = interaction.options.getString("template") ?? "{user}'s Channel";
      const voice = await interaction.guild!.channels.create({
        name: "➕ Join to Create",
        type: ChannelType.GuildVoice,
        parent: category.id,
      });
      await GuildConfig.updateOne(
        { guildId },
        { $set: { tempVoice: { joinChannelId: voice.id, categoryId: category.id, nameTemplate: template } } },
        { upsert: true },
      );
      invalidateGuildConfig(guildId);
      await interaction.editReply(`✅ Join-to-create voice channel created in **${category.name}**.`);
      return;
    }

    const current = await currentTempDoc(interaction);
    if (!current) {
      await interaction.editReply("You must be inside one of my temporary voice channels to use this.");
      return;
    }

    if (sub === "claim") {
      const owner = await interaction.guild!.members.fetch(current.doc.ownerId).catch(() => null);
      const ownerPresent = owner?.voice.channelId === current.doc.channelId;
      if (ownerPresent) {
        await interaction.editReply("The current owner is still in the channel.");
        return;
      }
      await TempVoice.updateOne({ _id: current.doc._id }, { $set: { ownerId: interaction.user.id } });
      await current.channel.permissionOverwrites.edit(
        interaction.user.id,
        { ManageChannels: true, MoveMembers: true, MuteMembers: true },
      ).catch(() => undefined);
      await interaction.editReply("📡 You claimed this channel.");
      return;
    }

    if (sub !== "claim" && current.doc.ownerId !== interaction.user.id) {
      await interaction.editReply("Only the channel owner can use this.");
      return;
    }

    if (sub === "lock" || sub === "unlock") {
      const locked = sub === "lock";
      await current.channel.permissionOverwrites.edit(interaction.guild!.roles.everyone, {
        Connect: locked ? false : null,
      });
      await TempVoice.updateOne({ _id: current.doc._id }, { $set: { locked } });
      await interaction.editReply(locked ? "🔒 Channel locked." : "🔓 Channel unlocked.");
      return;
    }

    if (sub === "permit" || sub === "deny") {
      const user = interaction.options.getUser("user", true);
      if (sub === "permit") {
        await current.channel.permissionOverwrites.edit(user.id, { Connect: true }).catch(() => undefined);
        await TempVoice.updateOne({ _id: current.doc._id }, { $pull: { deniedUserIds: user.id } });
        await interaction.editReply(`✅ <@${user.id}> can now join your channel.`);
      } else {
        await current.channel.permissionOverwrites.edit(user.id, { Connect: false }).catch(() => undefined);
        await TempVoice.updateOne({ _id: current.doc._id }, { $addToSet: { deniedUserIds: user.id } });
        const target = current.channel.members.get(user.id);
        if (target) await target.voice.disconnect("Temp voice channel denied").catch(() => undefined);
        await interaction.editReply(`⛔ <@${user.id}> was denied and kicked from your channel.`);
      }
      return;
    }

    if (sub === "name") {
      const name = interaction.options.getString("name", true).slice(0, 90);
      await current.channel.setName(name).catch(() => undefined);
      await interaction.editReply(`✏️ Channel renamed to **${name}**.`);
      return;
    }
  },
};

const clientReadyForStale = {
  name: "clientReady" as const,
  run: async (client: Client): Promise<void> => {
    if (staleChecked) return;
    staleChecked = true;
    setInterval(() => {
      void (async () => {
        const docs = await TempVoice.find();
        for (const doc of docs) {
          const guild = client.guilds.cache.get(doc.guildId);
          if (!guild || !guild.channels.cache.has(doc.channelId)) {
            await TempVoice.deleteOne({ _id: doc._id });
          }
        }
      })();
    }, 300_000);
  },
};

export const tempVoiceModule: Module = {
  name: "tempvoice",
  description: "Join-to-create temporary voice channels",
  defaultEnabled: true,
  commands: [vcCommand],
  events: [{ name: "voiceStateUpdate", run: onVoiceStateUpdate }, clientReadyForStale],
};
