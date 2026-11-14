import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import mongoose from "mongoose";
import { config } from "../core/config";
import { Backup, type IBackup } from "../db/models";
import { EPHEMERAL, makeEmbed, relTime, truncate } from "../core/util";
import type { Module, ModuleCommand } from "../core/types";

const backupCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("backup")
    .setDescription("Server structure backups")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Snapshot roles and channels (does NOT save permissions or messages)")
        .addStringOption((opt) => opt.setName("name").setDescription("Backup name").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List saved backups")),
  run: async (_client, interaction) => {
    await interaction.deferReply({ flags: EPHEMERAL });
    const guild = interaction.guild!;
    const sub = interaction.options.getSubcommand();

    if (sub === "create") {
      const name = interaction.options.getString("name", true).slice(0, 50);
      await interaction.editReply("📦 Snapshotting the server...");
      const roles = guild.roles.cache.map((role) => ({
        name: role.name,
        color: role.color,
        hoist: role.hoist,
        mentionable: role.mentionable,
        permissions: role.permissions.toString(),
      }));
      const channels = guild.channels.cache.map((channel) => ({
        oldId: channel.id,
        name: channel.name,
        type: channel.type,
        parentId: "parentId" in channel ? channel.parentId : null,
        topic: "topic" in channel ? channel.topic ?? null : null,
        bitrate: "bitrate" in channel ? channel.bitrate ?? null : null,
        userLimit: "userLimit" in channel ? channel.userLimit ?? null : null,
        nsfw: "nsfw" in channel ? channel.nsfw ?? false : false,
        rateLimit: "rateLimitPerUser" in channel ? (channel as any).rateLimitPerUser ?? 0 : 0,
      }));
      const doc = await Backup.create({
        guildId: guild.id,
        name,
        createdBy: interaction.user.id,
        data: { roles, channels },
        createdAt: new Date(),
      });
      const embed = makeEmbed(config.embedColors.success)
        .setTitle("Backup created")
        .setDescription(`**${name}** (\`${doc._id}\`)\n- Roles: **${roles.length}**\n- Channels: **${channels.length}**`);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === "list") {
      const docs = await Backup.find({ guildId: guild.id }).sort({ createdAt: -1 }).limit(10);
      if (docs.length === 0) {
        await interaction.editReply("No backups yet. Create one with `/backup create`.");
        return;
      }
      const lines = docs.map(
        (d: IBackup) =>
          `- \`${d._id}\` **${d.name}** by <@${d.createdBy}> (${relTime(d.createdAt)}) — ${d.data.channels.length} channels, ${d.data.roles.length} roles`,
      );
      await interaction.editReply({ embeds: [makeEmbed(config.embedColors.primary).setTitle("Backups").setDescription(lines.join("\n"))] });
      return;
    }
  },
};

const backupLoadCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("backupload")
    .setDescription("Restore channels/roles missing from a backup")
    .addStringOption((opt) => opt.setName("id").setDescription("Backup ID from /backup list").setRequired(true))
    .addBooleanOption((opt) => opt.setName("roles").setDescription("Restore missing roles (default true)"))
    .addBooleanOption((opt) => opt.setName("channels").setDescription("Restore missing channels (default true)")),
  run: async (client, interaction) => {
    await interaction.deferReply({ flags: EPHEMERAL });
    const guild = interaction.guild!;
    const id = interaction.options.getString("id", true);
    if (!mongoose.isValidObjectId(id)) {
      await interaction.editReply("That ID doesn't look valid — copy it from `/backup list`.");
      return;
    }
    const doc = await Backup.findOne({ _id: id, guildId: guild.id });
    if (!doc) {
      await interaction.editReply("Backup not found.");
      return;
    }

    await interaction.editReply("♻️ Restoring (this can take a while)...");
    const diff: string[] = [];
    const createdChannels: string[] = [];
    const createdRoles: string[] = [];

    // roles
    if (interaction.options.getBoolean("roles") ?? true) {
      const existingNames = new Set(guild.roles.cache.map((r) => r.name.toLowerCase()));
      for (const role of doc.data.roles) {
        if (existingNames.has(role.name.toLowerCase()) || role.name === "@everyone") continue;
        try {
          const created = await guild.roles.create({
            name: role.name,
            color: role.color,
            hoist: role.hoist,
            mentionable: role.mentionable,
            permissions: BigInt(role.permissions || "0"),
            reason: "Backup restore",
          });
          createdRoles.push(created.name);
        } catch (err) {
          diff.push(`role \`${truncate(role.name, 30)}\`: ${err instanceof Error ? err.message : "failed"}`);
        }
      }
    }

    // channels — categories first so children can be attached
    if (interaction.options.getBoolean("channels") ?? true) {
      const categories = doc.data.channels.filter((c) => c.type === 4 /* GuildCategory */);
      const children = doc.data.channels.filter((c) => c.type !== 4);
      const oldIdToNew = new Map<string, string>();
      const existingNames = new Set(guild.channels.cache.map((c) => `${c.type}:${c.name}`));

      for (const category of categories) {
        if (existingNames.has(`${category.type}:${category.name}`)) continue;
        try {
          const created = await guild.channels.create({ name: category.name, type: 4, reason: "Backup restore" });
          oldIdToNew.set(category.oldId, created.id);
          createdChannels.push(created.name);
        } catch (err) {
          diff.push(`category \`${truncate(category.name, 30)}\`: ${err instanceof Error ? err.message : "failed"}`);
        }
      }
      for (const child of children) {
        if (existingNames.has(`${child.type}:${child.name}`)) continue;
        try {
          const parent = child.parentId ? oldIdToNew.get(child.parentId) ?? guild.channels.cache.get(child.parentId)?.id ?? undefined : undefined;
          const created = await guild.channels.create({
            name: child.name,
            type: child.type as any,
            parent,
            topic: child.topic ?? undefined,
            nsfw: child.nsfw ?? false,
            reason: "Backup restore",
            ...(child.type === 2 ? { bitrate: child.bitrate ?? undefined, userLimit: child.userLimit ?? undefined } : {}),
          });
          if (child.type !== 4 && "setRateLimitPerUser" in created) {
            await (created as any).setRateLimitPerUser(child.rateLimit ?? 0).catch(() => undefined);
          }
          oldIdToNew.set(child.oldId, created.id);
          createdChannels.push(created.name);
        } catch (err) {
          diff.push(`channel \`${truncate(child.name, 30)}\`: ${err instanceof Error ? err.message : "failed"}`);
        }
      }
    }

    const embed = makeEmbed(config.embedColors.primary)
      .setTitle("Backup restored")
      .setDescription(
        [
          `Roles recreated: **${createdRoles.length}**${createdRoles.length ? `\n${createdRoles.map((r) => `\`${r}\``).join(", ").slice(0, 900)}` : ""}`,
          `Channels recreated: **${createdChannels.length}**${createdChannels.length ? `\n${createdChannels.map((r) => `\`#${r}\``).join(", ").slice(0, 900)}` : ""}`,
          diff.length ? `**Failures:**\n${diff.slice(0, 10).join("\n")}` : null,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
    await interaction.editReply({ embeds: [embed] });
  },
};

const backupDeleteCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("backupdelete")
    .setDescription("Delete one of your backups")
    .addStringOption((opt) => opt.setName("id").setDescription("Backup ID from /backup list").setRequired(true)),
  run: async (_client, interaction) => {
    await interaction.deferReply({ flags: EPHEMERAL });
    const id = interaction.options.getString("id", true);
    if (!mongoose.isValidObjectId(id)) {
      await interaction.editReply("Invalid backup ID.");
      return;
    }
    const isManager = interaction.inCachedGuild() && interaction.member.permissions.has(PermissionFlagsBits.ManageGuild);
    const filter = isManager
      ? { _id: id, guildId: interaction.guildId }
      : { _id: id, guildId: interaction.guildId, createdBy: interaction.user.id };
    const deleted = await Backup.deleteOne(filter);
    if (deleted.deletedCount === 0) {
      await interaction.editReply("Backup not found (or not yours).");
      return;
    }
    await interaction.editReply("🗑 Backup deleted.");
  },
};

export const backupsModule: Module = {
  name: "backups",
  description: "Server structure backups",
  defaultEnabled: true,
  commands: [backupCommand, backupLoadCommand, backupDeleteCommand],
};
