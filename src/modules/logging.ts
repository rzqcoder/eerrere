import {
  EmbedBuilder,
  SlashCommandBuilder,
  ChannelType,
  MessageFlags,
  type Channel,
  type GuildMember,
  type Message,
  type VoiceState,
} from "discord.js";
import { config } from "../core/config";
import { getGuildConfig } from "../db/guildConfig";
import { GuildConfig } from "../db/models";
import { makeEmbed, truncate } from "../core/util";
import type { Module, ModuleCommand, ModuleInteraction } from "../core/types";

type LogClient = Parameters<ModuleInteraction["run"]>[0];

export const LOG_TYPES = [
  "message-delete",
  "message-edit",
  "member-join",
  "member-leave",
  "member-roles",
  "role-changes",
  "channel-changes",
  "voice",
  "moderation",
  "bans",
] as const;
export type LogType = (typeof LOG_TYPES)[number];

const logChoice = (type: LogType) => ({ name: type, value: type });

async function logTo(
  client: Parameters<ModuleInteraction["run"]>[0],
  guildId: string,
  type: LogType,
  color: number,
  lines: Array<string | null>,
): Promise<void> {
  try {
    const cfg = await getGuildConfig(guildId);
    const channelId = cfg.logChannels?.get(type);
    if (!channelId) return;
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    if (!("guild" in channel) || channel.guild.id !== guildId) return;
    const embed = makeEmbed(color).setDescription(lines.filter(Boolean).join("\n")).setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch (err) {
    console.error(`[logging:${type}]`, err);
  }
}

const refChannel = (channel: Channel | null | undefined): string => {
  const anyChannel = channel as any;
  if (!anyChannel) return "*deleted*";
  return anyChannel.type === ChannelType.GuildVoice || anyChannel.type === ChannelType.GuildStageVoice
    ? `\`${anyChannel.name}\``
    : `<#${anyChannel.id}>`;
};

/* -------------------------------------- command -------------------------------------- */

const loggingCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("logging")
    .setDescription("Configure logging channels")
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Route a log type to a channel (channel must already receive that kind of event)")
        .addStringOption((opt) =>
          opt.setName("type").setDescription("Log type").setRequired(true).addChoices(LOG_TYPES.map(logChoice)),
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to log to")
            .setRequired(true)
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("clear")
        .setDescription("Stop logging one type")
        .addStringOption((opt) =>
          opt.setName("type").setDescription("Log type").setRequired(true).addChoices(LOG_TYPES.map(logChoice)),
        ),
    )
    .addSubcommand((sub) => sub.setName("show").setDescription("Show current log destinations")),
  run: async (client, interaction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    if (!guildId) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "show") {
      const cfg = await getGuildConfig(guildId);
      const lines = LOG_TYPES.map((t) => {
        const id = cfg.logChannels?.get(t);
        return `- **${t}**: ${id ? `<#${id}>` : "not set"}`;
      }).join("\n");
      const embed = makeEmbed(config.embedColors.primary).setTitle("Logging destinations").setDescription(lines);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    const type = interaction.options.getString("type", true) as LogType;
    if (sub === "clear") {
      await GuildConfig.updateOne({ guildId }, { $unset: { [`logChannels.${type}`]: "" } }, { upsert: true });
      await getGuildConfig(guildId, { fresh: true });
      await interaction.editReply(`Cleared logging for **${type}**.`);
      return;
    }

    const channel = interaction.options.getChannel("channel", true);
    await GuildConfig.updateOne(
      { guildId },
      { $set: { [`logChannels.${type}`]: channel.id } },
      { upsert: true },
    );
    await getGuildConfig(guildId, { fresh: true });
    await interaction.editReply(`Logs of type **${type}** will be posted in <#${channel.id}>.`);
  },
};

/* -------------------------------------- events --------------------------------------- */

const onMessageDelete = async (client: LogClient, message: Message): Promise<void> => {
  if (!message.inGuild() || message.author?.bot) return;
  const attachments = [...message.attachments.values()];
  await logTo(client, message.guild.id, "message-delete", config.embedColors.warning, [
    `🗑 **Message deleted** in <#${message.channelId}>`,
    `**Author:** <@${message.author?.id ?? "unknown"}>`,
    message.content ? `**Content:** ${truncate(message.content)}` : null,
    attachments.length ? `**Attachments:** ${attachments.map((a) => a.name ?? a.url).join(", ")}` : null,
  ]);
};

const onMessageUpdate = async (
  client: LogClient,
  oldMessage: Message,
  newMessage: Message,
): Promise<void> => {
  if (!newMessage.inGuild() || !newMessage.author || newMessage.author.bot) return;
  if (oldMessage.content === newMessage.content) return;
  await logTo(client, newMessage.guild.id, "message-edit", config.embedColors.primary, [
    `✏️ **Message edited** in <#${newMessage.channelId}> — [jump](<${newMessage.url}>)`,
    `**Author:** <@${newMessage.author.id}>`,
    `**Before:** ${oldMessage.content ? truncate(oldMessage.content, 1000) : "(not cached)"}`,
    `**After:** ${newMessage.content ? truncate(newMessage.content, 1000) : null}`,
  ]);
};

const onMemberAdd = async (client: LogClient, member: GuildMember): Promise<void> => {
  await logTo(client, member.guild.id, "member-join", config.embedColors.success, [
    `📥 **Member joined** <@${member.id}> (${member.user.tag})`,
  ]);
};

const onMemberRemove = async (client: LogClient, member: GuildMember): Promise<void> => {
  await logTo(client, member.guild.id, "member-leave", config.embedColors.warning, [
    `📤 **Member left** <@${member.id}> (${member.user.tag})`,
  ]);
};

const onMemberUpdate = async (
  client: LogClient,
  oldMember: GuildMember,
  member: GuildMember,
): Promise<void> => {
  const before = new Set(oldMember.roles.cache.map((r) => r.id));
  const after = new Set(member.roles.cache.map((r) => r.id));
  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  if (added.length === 0 && removed.length === 0) return;
  await logTo(client, member.guild.id, "member-roles", config.embedColors.primary, [
    `🧬 **Roles changed** for <@${member.id}>`,
    added.length ? `**Added:** ${added.map((id) => `<@&${id}>`).join(", ")}` : null,
    removed.length ? `**Removed:** ${removed.map((id) => `<@&${id}>`).join(", ")}` : null,
  ]);
};

const onRoleChanges = async (
  client: LogClient,
  oldRole: any,
  role: any,
): Promise<void> => {
  if (role.guild.id !== oldRole.guild.id) return;
  await logTo(client, role.guild.id, "role-changes", config.embedColors.primary, [
    `🛠 **Role updated** <@&${role.id}>`,
    oldRole.name !== role.name ? `- name: \`${oldRole.name}\` → \`${role.name}\`` : null,
    oldRole.hexColor !== role.hexColor ? `- color: \`${oldRole.hexColor}\` → \`${role.hexColor}\`` : null,
  ]);
};

const onRoleChangesCreate = async (client: LogClient, role: any): Promise<void> => {
  await logTo(client, role.guild.id, "role-changes", config.embedColors.primary, [
    `🆕 **Role created** <@&${role.id}> \`${role.name}\``,
  ]);
};

const onRoleChangesDelete = async (client: LogClient, role: any): Promise<void> => {
  await logTo(client, role.guild.id, "role-changes", config.embedColors.warning, [
    `🗑 **Role deleted** \`${role.name}\``,
  ]);
};

const onChannelChange = async (client: LogClient, oldChannel: Channel, channel: Channel): Promise<void> => {
  if (!("guild" in channel) || !channel.guild || channel.guild.id !== (oldChannel as any).guild?.id) return;
  const oldName = (oldChannel as any).name;
  const newName = (channel as any).name;
  await logTo(client, channel.guild.id, "channel-changes", config.embedColors.primary, [
    `🔁 **Channel updated** <#${channel.id}>`,
    oldName !== newName ? `- name: \`${oldName}\` → \`${newName}\`` : null,
  ]);
};

const onChannelCreate = async (client: LogClient, channel: Channel): Promise<void> => {
  if (!("guild" in channel) || !channel.guild) return;
  const name = (channel as any).name;
  await logTo(client, channel.guild.id, "channel-changes", config.embedColors.primary, [
    `🆕 **Channel created** <#${channel.id}> (${channel.type}) \`${name}\``,
  ]);
};

const onChannelDelete = async (client: LogClient, channel: Channel): Promise<void> => {
  if (!("guild" in channel) || !channel.guild) return;
  const name = (channel as any).name;
  await logTo(client, channel.guild.id, "channel-changes", config.embedColors.warning, [
    `🗑 **Channel deleted** \`${name}\` (${channel.type})`,
  ]);
};

const onVoiceState = async (client: LogClient, oldState: VoiceState, state: VoiceState): Promise<void> => {
  if (!state.guild || !state.member || state.member.user.bot) return;
  if (oldState.channelId === state.channelId) return;
  await logTo(client, state.guild.id, "voice", config.embedColors.primary, [
    `🔊 **Voice update** for <@${state.member.id}>`,
    !oldState.channelId ? `- joined ${refChannel(oldState.channel)}` : null,
    !state.channelId ? `- left ${refChannel(oldState.channel)}` : null,
    oldState.channelId && state.channelId ? `- moved ${refChannel(oldState.channel)} → ${refChannel(state.channel)}` : null,
  ]);
};

const onBanAdd = async (client: LogClient, ban: any): Promise<void> => {
  await logTo(client, ban.guild.id, "bans", config.embedColors.danger, [
    `🔨 **User banned** <@${ban.user.id}> (${ban.user.tag})`,
    ban.reason ? `**Reason:** ${truncate(ban.reason, 1000)}` : null,
  ]);
};

const onBanRemove = async (client: LogClient, ban: any): Promise<void> => {
  await logTo(client, ban.guild.id, "bans", config.embedColors.success, [
    `🕊 **User unbanned** <@${ban.user.id}> (${ban.user.tag})`,
  ]);
};

export const loggingModule: Module = {
  name: "logging",
  description: "Server events logged into configurable channels",
  defaultEnabled: true,
  commands: [loggingCommand],
  events: [
    { name: "messageDelete", run: onMessageDelete },
    { name: "messageUpdate", run: onMessageUpdate },
    { name: "guildMemberAdd", run: onMemberAdd },
    { name: "guildMemberRemove", run: onMemberRemove },
    { name: "guildMemberUpdate", run: onMemberUpdate },
    { name: "roleUpdate", run: onRoleChanges },
    { name: "roleCreate", run: onRoleChangesCreate },
    { name: "roleDelete", run: onRoleChangesDelete },
    { name: "channelUpdate", run: onChannelChange },
    { name: "channelCreate", run: onChannelCreate },
    { name: "channelDelete", run: onChannelDelete },
    { name: "voiceStateUpdate", run: onVoiceState },
    { name: "guildBanAdd", run: onBanAdd },
    { name: "guildBanRemove", run: onBanRemove },
  ],
};
