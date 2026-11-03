import {
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Client,
  type GuildMember,
  type Message,
  type Role,
} from "discord.js";
import { config } from "../core/config";
import { EPHEMERAL, makeEmbed, parseDuration, relTime, toLocale, truncate } from "../core/util";
import { Reminder, Tag, type IReminder } from "../db/models";
import type { Module, ModuleCommand, ModuleEvent } from "../core/types";

/* -------------------------------------- snipe --------------------------------------- */

interface SnipedMessage {
  id: string;
  channelId: string;
  authorTag: string;
  authorId: string;
  authorAvatar: string | null;
  content: string;
  attachments: string[];
  createdAt: number;
  deletedAt: number;
}

/** channelId -> deleted messages, newest first */
const snipeCache = new Map<string, SnipedMessage[]>();
const SNIPE_LIMIT = 20;

function rememberSnipe(message: Message): void {
  const content = message.content ?? "";
  const attachments = message.attachments.map((a) => a.url);
  if (!content && attachments.length === 0) return;
  const entry: SnipedMessage = {
    id: message.id,
    channelId: message.channelId,
    authorTag: message.author?.tag ?? "unknown",
    authorId: message.author?.id ?? "0",
    authorAvatar: message.author?.displayAvatarURL() ?? null,
    content,
    attachments,
    createdAt: message.createdTimestamp,
    deletedAt: Date.now(),
  };
  const list = snipeCache.get(message.channelId) ?? [];
  list.unshift(entry);
  snipeCache.set(message.channelId, list.slice(0, SNIPE_LIMIT));
}

const onMessageDelete = async (_client: Client, message: Message): Promise<void> => {
  if (!message.guildId) return;
  let full = message;
  if (message.partial) {
    const fetched = await message.fetch().catch(() => null);
    if (!fetched) return;
    full = fetched;
  }
  rememberSnipe(full);
};

const onMessageDeleteBulk = async (
  _client: Client,
  messages: Map<string, Message>,
): Promise<void> => {
  for (const [, message] of messages) {
    if (!message.guildId) continue;
    let full = message;
    if (message.partial) {
      const fetched = await message.fetch().catch(() => null);
      if (!fetched) continue;
      full = fetched;
    }
    // bulk collections arrive oldest-first; keep snipe order newest-first
    rememberSnipe(full);
  }
};

const snipeCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("snipe")
    .setDescription("Show the last deleted message in a channel")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Channel to check (default: here)")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  run: async (_client, interaction) => {
    const chosen = interaction.options.getChannel("channel");
    const channelId = chosen?.id ?? interaction.channelId;
    const entry = snipeCache.get(channelId)?.[0];
    if (!entry) {
      await interaction.reply({
        content: "Nothing was deleted in that channel recently.",
        flags: EPHEMERAL,
      });
      return;
    }
    const embed = makeEmbed(config.embedColors.danger)
      .setTitle("🗑 Last deleted message")
      .setAuthor({ name: entry.authorTag, iconURL: entry.authorAvatar ?? undefined })
      .setDescription(entry.content ? truncate(entry.content, 1500) : "*No text content.*")
      .setFooter({ text: `Message ID ${entry.id} • deleted <t:${Math.floor(entry.deletedAt / 1000)}:R>` })
      .setTimestamp(new Date(entry.deletedAt));
    if (entry.attachments.length > 0) {
      embed.addFields({
        name: `Attachments (${entry.attachments.length})`,
        value: entry.attachments.slice(0, 6).map((u) => truncate(u, 180)).join("\n").slice(0, 1024),
      });
    }
    embed.addFields({ name: "Author", value: `<@${entry.authorId}> • sent <t:${Math.floor(entry.createdAt / 1000)}:R>` });
    await interaction.reply({ embeds: [embed] });
  },
};

/* ------------------------------------ userinfo -------------------------------------- */

const KEY_PERMS: Array<[string, bigint]> = [
  ["Administrator", PermissionFlagsBits.Administrator],
  ["Manage Server", PermissionFlagsBits.ManageGuild],
  ["Manage Roles", PermissionFlagsBits.ManageRoles],
  ["Manage Channels", PermissionFlagsBits.ManageChannels],
  ["Manage Messages", PermissionFlagsBits.ManageMessages],
  ["Ban Members", PermissionFlagsBits.BanMembers],
  ["Kick Members", PermissionFlagsBits.KickMembers],
  ["Timeout Members", PermissionFlagsBits.ModerateMembers],
];

const userinfoCommand: ModuleCommand = {
  public: true,
  data: new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Details about a member")
    .addUserOption((opt) => opt.setName("user").setDescription("Member to inspect (default: you)")),
  run: async (_client, interaction) => {
    const user = interaction.options.getUser("user") ?? interaction.user;
    const member: GuildMember | null = await interaction.guild?.members
      .fetch(user.id)
      .catch(() => null) ?? null;

    const perms = member
      ? member.permissions.has(PermissionFlagsBits.Administrator)
        ? "Administrator (all permissions)"
        : KEY_PERMS.filter(([, flag]) => member.permissions.has(flag))
            .map(([name]) => name)
            .join(", ") || "None"
      : "unknown";

    const embed = makeEmbed(config.embedColors.primary)
      .setTitle(`UserInfo — ${user.tag}`)
      .setThumbnail(user.displayAvatarURL({ size: 256 }))
      .addFields(
        { name: "ID", value: user.id, inline: true },
        { name: "Account created", value: relTime(user.createdAt), inline: true },
        { name: "Joined server", value: member?.joinedAt ? relTime(member.joinedAt) : "unknown", inline: true },
        {
          name: "Roles",
          value: member
            ? `${member.roles.cache.size - 1} roles • top: ${member.roles.highest.name}`
            : "unknown",
          inline: true,
        },
        { name: "Bot", value: user.bot ? "Yes" : "No", inline: true },
        { name: "Timed out", value: member?.isCommunicationDisabled() ? "Yes" : "No", inline: true },
        { name: "Key permissions", value: truncate(perms, 1024) },
      );
    await interaction.reply({ embeds: [embed] });
  },
};

/* ----------------------------------- serverinfo ------------------------------------- */

const serverinfoCommand: ModuleCommand = {
  public: true,
  data: new SlashCommandBuilder().setName("serverinfo").setDescription("Details about this server"),
  run: async (_client, interaction) => {
    const guild = interaction.guild;
    if (!guild) return;
    const channels = guild.channels.cache;
    const count = (type: number) => channels.filter((c) => c.type === type).size;
    const members = guild.members.cache;
    const humans = members.filter((m) => !m.user.bot).size;
    const bots = members.filter((m) => m.user.bot).size;

    const embed = makeEmbed(config.embedColors.primary)
      .setTitle(`ServerInfo — ${guild.name}`)
      .setThumbnail(guild.iconURL({ size: 256 }))
      .addFields(
        { name: "ID", value: guild.id, inline: true },
        { name: "Owner", value: `<@${guild.ownerId}>`, inline: true },
        { name: "Created", value: relTime(guild.createdAt), inline: true },
        {
          name: "Members",
          value: `${toLocale(guild.memberCount)} total (${toLocale(humans)} humans, ${toLocale(bots)} bots)`,
          inline: true,
        },
        {
          name: "Channels",
          value: `${channels.size} total — ${count(ChannelType.GuildText)} text, ${count(ChannelType.GuildVoice)} voice, ${count(ChannelType.GuildAnnouncement)} announcement, ${count(ChannelType.GuildCategory)} categories, ${count(ChannelType.GuildStageVoice)} stage, ${count(ChannelType.GuildForum)} forum`,
        },
        {
          name: "Roles / Emojis / Stickers",
          value: `${guild.roles.cache.size - 1} • ${guild.emojis.cache.size} • ${guild.stickers.cache.size}`,
          inline: true,
        },
        { name: "Verification", value: String(guild.verificationLevel), inline: true },
        {
          name: "Boosts",
          value: `Tier ${guild.premiumTier} • ${guild.premiumSubscriptionCount ?? 0} boosts`,
          inline: true,
        },
      );
    await interaction.reply({ embeds: [embed] });
  },
};

/* -------------------------------------- poll ---------------------------------------- */

const POLL_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];

const pollCommand: ModuleCommand = {
  public: true,
  data: new SlashCommandBuilder()
    .setName("poll")
    .setDescription("Create a reaction poll")
    .addStringOption((opt) => opt.setName("question").setDescription("The question").setRequired(true).setMaxLength(300))
    .addStringOption((opt) => opt.setName("option1").setDescription("Option 1").setRequired(true).setMaxLength(100))
    .addStringOption((opt) => opt.setName("option2").setDescription("Option 2").setRequired(true).setMaxLength(100))
    .addStringOption((opt) => opt.setName("option3").setDescription("Option 3").setMaxLength(100))
    .addStringOption((opt) => opt.setName("option4").setDescription("Option 4").setMaxLength(100))
    .addStringOption((opt) => opt.setName("option5").setDescription("Option 5").setMaxLength(100))
    .addStringOption((opt) => opt.setName("option6").setDescription("Option 6").setMaxLength(100))
    .addStringOption((opt) => opt.setName("option7").setDescription("Option 7").setMaxLength(100))
    .addStringOption((opt) => opt.setName("option8").setDescription("Option 8").setMaxLength(100))
    .addStringOption((opt) => opt.setName("option9").setDescription("Option 9").setMaxLength(100))
    .addStringOption((opt) => opt.setName("option10").setDescription("Option 10").setMaxLength(100)),
  run: async (_client, interaction) => {
    const question = interaction.options.getString("question", true);
    const options = Array.from({ length: 10 }, (_, i) => interaction.options.getString(`option${i + 1}`)).filter(
      (v): v is string => !!v,
    );
    const embed = makeEmbed(config.embedColors.primary)
      .setTitle(`📊 ${question}`)
      .setDescription(options.map((opt, i) => `${POLL_EMOJIS[i]} ${opt}`).join("\n"))
      .setFooter({ text: `Poll by ${interaction.user.tag} • react to vote` });
    const message = await interaction.reply({ embeds: [embed], fetchReply: true });
    for (let i = 0; i < options.length; i++) {
      await message.react(POLL_EMOJIS[i]!).catch(() => undefined);
    }
  },
};

/* ------------------------------------ remind ---------------------------------------- */

const remindCommand: ModuleCommand = {
  public: true,
  data: new SlashCommandBuilder()
    .setName("remind")
    .setDescription("Set a personal reminder")
    .addSubcommand((sub) =>
      sub
        .setName("create")
        .setDescription("Remind you about something")
        .addStringOption((opt) =>
          opt.setName("time").setDescription("How long from now, e.g. 10m, 2h, 1d").setRequired(true),
        )
        .addStringOption((opt) =>
          opt.setName("message").setDescription("What to remind you about").setRequired(true).setMaxLength(500),
        ),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List your pending reminders")),
  run: async (_client, interaction) => {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    if (!guildId) return;

    if (sub === "create") {
      const time = interaction.options.getString("time", true);
      const content = interaction.options.getString("message", true);
      const ms = parseDuration(time);
      if (!ms || ms < 5_000) throw new Error("Invalid duration. Try formats like `10m`, `2h`, `1d` (minimum 5 seconds).");
      if (ms > 365 * 86_400_000) throw new Error("Reminders are limited to 1 year.");
      const dueAt = new Date(Date.now() + ms);
      await Reminder.create({
        guildId,
        userId: interaction.user.id,
        channelId: interaction.channelId,
        content,
        dueAt,
        createdAt: new Date(),
      });
      await interaction.reply({
        content: `⏰ I'll remind you ${relTime(dueAt)}: **${truncate(content, 200)}**`,
        flags: EPHEMERAL,
      });
      return;
    }

    const docs = await Reminder.find({ userId: interaction.user.id, sentAt: null })
      .sort({ dueAt: 1 })
      .limit(15);
    if (docs.length === 0) {
      await interaction.reply({ content: "You have no pending reminders.", flags: EPHEMERAL });
      return;
    }
    const lines = docs.map((d) => `- ${relTime(d.dueAt)} — ${truncate(d.content, 80)}`);
    await interaction.reply({
      content: `**Your reminders**\n${lines.join("\n")}`,
      flags: EPHEMERAL,
    });
  },
};

async function deliverReminder(r: IReminder): Promise<void> {
  try {
    const { client } = await import("../core/client");
    const guildName = client.guilds.cache.get(r.guildId)?.name ?? "a server";
    const text = `⏰ Reminder in **${guildName}**: ${truncate(r.content, 1800)}`;
    const user = await client.users.fetch(r.userId).catch(() => null);
    let delivered = false;
    if (user) {
      delivered = await user
        .send(text)
        .then(() => true)
        .catch(() => false);
    }
    if (!delivered) {
      const channel = await client.channels.fetch(r.channelId).catch(() => null);
      if (channel && "send" in channel) {
        await (channel as any)
          .send({ content: `<@${r.userId}> ${text}` })
          .catch(() => undefined);
      }
    }
  } catch (err) {
    console.error("[remind] delivery failed:", err);
  }
}

async function tickReminders(): Promise<void> {
  try {
    const due = await Reminder.find({ sentAt: null, dueAt: { $lte: new Date() } }).limit(50);
    for (const r of due) {
      // claim it first so a restart never double-sends
      const claim = await Reminder.updateOne({ _id: r._id, sentAt: null }, { $set: { sentAt: new Date() } });
      if (claim.matchedCount === 0) continue;
      await deliverReminder(r);
    }
  } catch (err) {
    console.error("[remind] tick failed:", err);
  }
}

const reminderTicker: ModuleEvent = {
  name: "clientReady",
  run: async () => {
    const started = reminderTicker as unknown as { started?: boolean };
    if (started.started) return;
    started.started = true;
    const timer = setInterval(() => void tickReminders(), 15_000);
    timer.unref?.();
    await tickReminders(); // catch anything that came due while the bot was down
  },
};

/* -------------------------------------- tag ----------------------------------------- */

const TAG_NAME_RE = /^[a-z0-9_-]{1,50}$/;

const tagCommand: ModuleCommand = {
  public: true, // viewing is public; add/remove require Manage Server inside the handler
  data: new SlashCommandBuilder()
    .setName("tag")
    .setDescription("Server tags: quick reusable text snippets")
    .addSubcommand((sub) =>
      sub.setName("get").setDescription("View a tag").addStringOption((opt) => opt.setName("name").setDescription("Tag name").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Create or update a tag (Manage Server)")
        .addStringOption((opt) => opt.setName("name").setDescription("Tag name (a-z, 0-9, - _)").setRequired(true).setMaxLength(50))
        .addStringOption((opt) => opt.setName("content").setDescription("Tag content").setRequired(true).setMaxLength(2000)),
    )
    .addSubcommand((sub) =>
      sub.setName("remove").setDescription("Delete a tag (Manage Server)").addStringOption((opt) => opt.setName("name").setDescription("Tag name").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List all tags")),
  run: async (_client, interaction) => {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    if (!guildId) return;

    if (sub === "get") {
      const name = interaction.options.getString("name", true).toLowerCase().trim();
      const doc = await Tag.findOne({ guildId, name });
      if (!doc) throw new Error(`Tag \`${truncate(name, 40)}\` does not exist.`);
      await Tag.updateOne({ _id: doc._id }, { $inc: { uses: 1 } });
      await interaction.reply({ content: doc.content });
      return;
    }

    const canManage = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
    if (!canManage) {
      await interaction.reply({ content: "You need the **Manage Server** permission to do that.", flags: EPHEMERAL });
      return;
    }

    if (sub === "add") {
      const name = interaction.options.getString("name", true).toLowerCase().trim();
      if (!TAG_NAME_RE.test(name)) {
        throw new Error("Tag names may only contain `a-z`, `0-9`, `-` and `_` (max 50 chars).");
      }
      const content = interaction.options.getString("content", true);
      await Tag.updateOne(
        { guildId, name },
        { $set: { content }, $setOnInsert: { createdBy: interaction.user.id, uses: 0, createdAt: new Date() } },
        { upsert: true },
      );
      await interaction.reply({ content: `🏷 Tag \`${name}\` saved.`, flags: EPHEMERAL });
      return;
    }

    if (sub === "remove") {
      const name = interaction.options.getString("name", true).toLowerCase().trim();
      const res = await Tag.deleteOne({ guildId, name });
      if (res.deletedCount === 0) {
        await interaction.reply({ content: `Tag \`${truncate(name, 40)}\` does not exist.`, flags: EPHEMERAL });
        return;
      }
      await interaction.reply({ content: `🏷 Tag \`${name}\` deleted.`, flags: EPHEMERAL });
      return;
    }

    // list
    const docs = await Tag.find({ guildId }).sort({ uses: -1 }).limit(25);
    if (docs.length === 0) {
      await interaction.reply({ content: "No tags yet. Add one with `/tag add`.", flags: EPHEMERAL });
      return;
    }
    const lines = docs.map((d) => `- \`${d.name}\` — ${truncate(d.content.split("\n")[0] ?? "", 60)} (${d.uses} uses)`);
    await interaction.reply({ content: `**Tags**\n${lines.join("\n")}`, flags: EPHEMERAL });
  },
};

/* -------------------------------------- role ---------------------------------------- */

const roleCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("role")
    .setDescription("Add or remove a member's roles")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Give a role to a member")
        .addUserOption((opt) => opt.setName("member").setDescription("Member").setRequired(true))
        .addRoleOption((opt) => opt.setName("role").setDescription("Role to give").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a role from a member")
        .addUserOption((opt) => opt.setName("member").setDescription("Member").setRequired(true))
        .addRoleOption((opt) => opt.setName("role").setDescription("Role to remove").setRequired(true)),
    ),
  run: async (_client, interaction) => {
    const guild = interaction.guild;
    if (!guild) return;
    const sub = interaction.options.getSubcommand();

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error("You need the **Manage Roles** permission to do that.");
    }
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error("I need the **Manage Roles** permission to do that.");
    }

    const user = interaction.options.getUser("member", true);
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new Error("That member is not in this server.");
    const role = interaction.options.getRole("role", true) as Role;
    if (role.managed) throw new Error("That role is managed by an integration and cannot be assigned manually.");
    if (role.id === guild.roles.everyone.id) throw new Error("You cannot assign `@everyone`.");
    if (role.position >= me.roles.highest.position) {
      throw new Error("That role is above (or equal to) my highest role.");
    }
    if (member.id !== me.id && role.position >= member.roles.highest.position) {
      throw new Error("That role is above that member's highest role.");
    }

    if (sub === "add") {
      if (member.roles.cache.has(role.id)) {
        await interaction.reply({ content: `${user.tag} already has **${role.name}**.`, flags: EPHEMERAL });
        return;
      }
      await member.roles.add(role, `Role command by ${interaction.user.tag}`);
      await interaction.reply({ content: `✅ Gave **${role.name}** to ${user.tag}.`, flags: EPHEMERAL });
      return;
    }

    if (!member.roles.cache.has(role.id)) {
      await interaction.reply({ content: `${user.tag} does not have **${role.name}**.`, flags: EPHEMERAL });
      return;
    }
    await member.roles.remove(role, `Role command by ${interaction.user.tag}`);
    await interaction.reply({ content: `✅ Removed **${role.name}** from ${user.tag}.`, flags: EPHEMERAL });
  },
};

/* -------------------------------------- nick ---------------------------------------- */

const nickCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("nick")
    .setDescription("Change a member's nickname")
    .addUserOption((opt) => opt.setName("member").setDescription("Member").setRequired(true))
    .addStringOption((opt) =>
      opt.setName("nickname").setDescription("New nickname (omit to reset)").setMaxLength(32),
    ),
  run: async (_client, interaction) => {
    const guild = interaction.guild;
    if (!guild) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageNicknames)) {
      throw new Error("You need the **Manage Nicknames** permission to do that.");
    }
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (!me.permissions.has(PermissionFlagsBits.ManageNicknames)) {
      throw new Error("I need the **Manage Nicknames** permission to do that.");
    }
    const user = interaction.options.getUser("member", true);
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) throw new Error("That member is not in this server.");
    if (!member.manageable) {
      throw new Error("I cannot change that member's nickname (role hierarchy).");
    }
    const nickname = interaction.options.getString("nickname");
    await member.setNickname(nickname ?? null, `Nickname command by ${interaction.user.tag}`);
    await interaction.reply({
      content: nickname ? `✅ Nickname for ${user.tag} set to **${truncate(nickname, 32)}**.` : `✅ Reset ${user.tag}'s nickname.`,
      flags: EPHEMERAL,
    });
  },
};

/* ------------------------------------- module --------------------------------------- */

export const utilityModule: Module = {
  name: "utility",
  description: "Snipe, user/server info, polls, reminders, tags, roles and nicknames",
  defaultEnabled: true,
  commands: [snipeCommand, userinfoCommand, serverinfoCommand, pollCommand, remindCommand, tagCommand, roleCommand, nickCommand],
  events: [
    { name: "messageDelete", run: onMessageDelete },
    { name: "messageDeleteBulk", run: onMessageDeleteBulk },
    reminderTicker,
  ],
};
