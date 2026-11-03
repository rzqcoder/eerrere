import { EmbedBuilder, MessageFlags, SlashCommandBuilder, type MessageReaction } from "discord.js";
import { config } from "../core/config";
import { ReactionRole, type IReactionRole } from "../db/models";
import { EPHEMERAL, makeEmbed } from "../core/util";
import type { Module, ModuleCommand, ModuleInteraction } from "../core/types";
import type { Client } from "discord.js";

function parseMessageRef(input: string): { messageId: string; channelId: string | null } {
  const link = input.match(/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (link) return { messageId: link[3]!, channelId: link[2]! };
  return { messageId: input, channelId: null };
}

function normalizeEmoji(raw: string): { key: string; display: string } {
  const custom = raw.match(/^<a?:[A-Za-z0-9_~]+:(\d+)>$/);
  if (custom) {
    const id = custom[1]!;
    return { key: id, display: raw };
  }
  return { key: raw.trim(), display: raw.trim() };
}

const NOT_IN_CACHE = Symbol("no-message");

async function findMessage(client: Client, guildId: string, messageId: string, channelId: string | null) {
  if (channelId) {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return NOT_IN_CACHE;
    return channel.messages.fetch(messageId).catch(() => NOT_IN_CACHE);
  }
  // search cached guild channels
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return NOT_IN_CACHE;
  for (const [, channel] of guild.channels.cache) {
    if (!channel.isTextBased() || !("messages" in channel)) continue;
    const cached = channel.messages.cache.get(messageId);
    if (cached) return cached;
  }
  return NOT_IN_CACHE;
}

const rrCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("rr")
    .setDescription("Reaction role configuration")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Bind an emoji on a message to a role")
        .addStringOption((opt) =>
          opt.setName("message").setDescription("Message ID or message link").setRequired(true),
        )
        .addStringOption((opt) => opt.setName("emoji").setDescription("Emoji to react with").setRequired(true))
        .addRoleOption((opt) => opt.setName("role").setDescription("Role to give").setRequired(true))
        .addBooleanOption((opt) =>
          opt.setName("unique").setDescription("Remove other bound roles when claiming one (default false)"),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove an emoji binding")
        .addStringOption((opt) =>
          opt.setName("message").setDescription("Message ID or message link").setRequired(true),
        )
        .addStringOption((opt) => opt.setName("emoji").setDescription("Emoji to unbind").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List reaction role setups")),
  run: async (client, interaction) => {
    await interaction.deferReply({ flags: EPHEMERAL });
    const guild = interaction.guild;
    if (!guild) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "add" || sub === "remove") {
      const ref = parseMessageRef(interaction.options.getString("message", true));
      const emojiRaw = interaction.options.getString("emoji", true);
      const emoji = normalizeEmoji(emojiRaw);
      const message = await findMessage(client, guild.id, ref.messageId, ref.channelId);
      if (message === NOT_IN_CACHE || !(message instanceof Object) || !("guild" in message)) {
        await interaction.editReply("Message not found. Use a message link or the full message ID.");
        return;
      }
      const msg = message as { id: string; channelId: string; guildId: string };

      if (sub === "add") {
        const role = interaction.options.getRole("role", true);
        if (role.id === interaction.guild.roles.everyone.id) {
          await interaction.editReply("You can't bind @everyone.");
          return;
        }
        const unique = interaction.options.getBoolean("unique") ?? false;
        const doc = await ReactionRole.findOne({ guildId: guild.id, messageId: msg.id });
        if (doc) {
          if (doc.unique !== unique) await ReactionRole.updateOne({ _id: doc._id }, { $set: { unique } });
          const existing = doc.bindings.find((b) => b.key === emoji.key);
          if (existing) {
            await ReactionRole.updateOne(
              { _id: doc._id, "bindings.key": emoji.key },
              { $set: { "bindings.$.roleId": role.id } },
            );
          } else {
            await ReactionRole.updateOne(
              { _id: doc._id },
              { $push: { bindings: { key: emoji.key, roleId: role.id } } },
            );
          }
        } else {
          await ReactionRole.create({
            guildId: guild.id,
            channelId: interaction.channelId,
            messageId: msg.id,
            unique,
            bindings: [{ key: emoji.key, roleId: role.id }],
            createdAt: new Date(),
          });
        }
        // pre-react once per emoji so members can click
        if ("react" in message) await (message as { react: (e: string) => Promise<unknown> }).react(emojiRaw).catch(() => undefined);
        await interaction.editReply(`Bound ${emojiRaw} → <@&${role.id}> on ${msg.channelId ? `<#${msg.channelId}>` : ""} message.`);
        return;
      }

      const doc = await ReactionRole.findOne({ guildId: guild.id, messageId: msg.id });
      if (!doc) {
        await interaction.editReply("No reaction roles are set on that message.");
        return;
      }
      await ReactionRole.updateOne({ _id: doc._id }, { $pull: { bindings: { key: emoji.key } } });
      if (doc.bindings.length - 1 <= 0) {
        await ReactionRole.deleteOne({ _id: doc._id });
      }
      await interaction.editReply(`Removed ${emojiRaw} from ${msg.channelId ? `<#${msg.channelId}>` : ""} message.`);
      return;
    }

    if (sub === "list") {
      const docs = await ReactionRole.find({ guildId: guild.id });
      if (docs.length === 0) {
        await interaction.editReply("No reaction roles configured.");
        return;
      }
      const lines = docs.map((doc) => {
        const bindings = doc.bindings.map((b) => `${b.key} → <@&${b.roleId}>`).join(", ");
        return `- <#${doc.channelId}> [${doc.messageId}]${doc.unique ? " *(one role at a time)*" : ""}\n${bindings}`;
      });
      const embed = new EmbedBuilder()
        .setColor(config.embedColors.primary)
        .setTitle("Reaction roles")
        .setDescription(lines.join("\n\n").slice(0, 4000));
      await interaction.editReply({ embeds: [embed] });
      return;
    }
  },
};

/* -------------------------------------- events --------------------------------------- */

function roleKey(reaction: MessageReaction): string | null {
  return reaction.emoji.id ?? reaction.emoji.name ?? null;
}

async function applyBinding(
  client: Parameters<ModuleInteraction["run"]>[0],
  reaction: MessageReaction,
  userId: string | undefined,
  granting: boolean,
): Promise<void> {
  if (!reaction.message.guildId || !userId || userId === client.user?.id) return;
  const key = roleKey(reaction);
  if (!key) return;
  const doc: IReactionRole | null = await ReactionRole.findOne({ guildId: reaction.message.guildId, messageId: reaction.message.id });
  if (!doc) return;
  const guild = client.guilds.cache.get(doc.guildId) ?? null;
  if (!guild) return;
  const binding = doc.bindings.find((b) => b.key === key);
  if (!binding) return;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  if (granting) {
    if (doc.unique) {
      for (const other of doc.bindings) {
        if (other.key === key) continue;
        if (member.roles.cache.has(other.roleId)) {
          await member.roles.remove(other.roleId, "reaction role (unique mode)").catch(() => undefined);
        }
      }
    }
    if (!member.roles.cache.has(binding.roleId)) {
      await member.roles.add(binding.roleId, "reaction role added").catch(() => undefined);
    }
  } else if (member.roles.cache.has(binding.roleId)) {
    await member.roles.remove(binding.roleId, "reaction role removed").catch(() => undefined);
  }
}

const onReactionAdd = async (
  client: Parameters<ModuleInteraction["run"]>[0],
  reaction: MessageReaction,
  userId: string,
): Promise<void> => {
  if (reaction.partial) reaction = await reaction.fetch().catch(() => reaction);
  await applyBinding(client, reaction, userId, true);
};

const onReactionRemove = async (
  client: Parameters<ModuleInteraction["run"]>[0],
  reaction: MessageReaction,
  userId: string,
): Promise<void> => {
  if (reaction.partial) reaction = await reaction.fetch().catch(() => reaction);
  await applyBinding(client, reaction, userId, false);
};

export const reactionRolesModule: Module = {
  name: "reactionroles",
  description: "Emoji reaction role bindings",
  defaultEnabled: true,
  commands: [rrCommand],
  events: [{ name: "messageReactionAdd", run: onReactionAdd }, { name: "messageReactionRemove", run: onReactionRemove }],
};

