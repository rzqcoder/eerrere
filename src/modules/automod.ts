import { PermissionFlagsBits, SlashCommandBuilder, type Client, type Message } from "discord.js";
import { AutoModWord, type IAutoModWord } from "../db/models";
import { EPHEMERAL, truncate } from "../core/util";
import type { Module, ModuleCommand } from "../core/types";

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Single words match on boundaries ("ass" won't hit "class"); phrases match as substrings. */
function matchesWord(content: string, word: string): boolean {
  const w = word.trim().toLowerCase();
  if (!w) return false;
  if (/\s/.test(w)) return content.toLowerCase().includes(w);
  try {
    return new RegExp(`\\b${escapeRegExp(w)}\\b`, "i").test(content);
  } catch {
    return content.toLowerCase().includes(w);
  }
}

const automodCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("automod")
    .setDescription("Custom word filter")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Block a word or phrase")
        .addStringOption((opt) => opt.setName("word").setDescription("Word or phrase to block").setRequired(true).setMaxLength(100))
        .addStringOption((opt) =>
          opt
            .setName("action")
            .setDescription("What to do on a hit (default delete)")
            .addChoices(
              { name: "delete message", value: "delete" },
              { name: "delete + timeout", value: "timeout" },
            ),
        )
        .addIntegerOption((opt) =>
          opt.setName("timeout").setDescription("Timeout seconds if action is timeout (default 60)").setMinValue(5).setMaxValue(2_419_200),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("remove").setDescription("Unblock a word").addStringOption((opt) => opt.setName("word").setDescription("Word to unblock").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("toggle")
        .setDescription("Enable or disable a blocked word")
        .addStringOption((opt) => opt.setName("word").setDescription("Word").setRequired(true))
        .addBooleanOption((opt) => opt.setName("enabled").setDescription("New state").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List blocked words")),
  run: async (_client, interaction) => {
    await interaction.deferReply({ flags: EPHEMERAL });
    const guildId = interaction.guildId;
    if (!guildId) return;
    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      const word = interaction.options.getString("word", true).trim().toLowerCase();
      const action = (interaction.options.getString("action") ?? "delete") as IAutoModWord["action"];
      const timeoutSec = interaction.options.getInteger("timeout") ?? 60;
      const existing = await AutoModWord.findOne({ guildId, word });
      if (existing) {
        await AutoModWord.updateOne(
          { _id: existing._id },
          { $set: { action, timeoutSec, enabled: true } },
        );
        await interaction.editReply(`Updated \`${truncate(word, 60)}\` → **${action}**.`);
        return;
      }
      await AutoModWord.create({
        guildId,
        word,
        action,
        timeoutSec,
        enabled: true,
        addedBy: interaction.user.id,
        createdAt: new Date(),
      });
      await interaction.editReply(`🚫 Blocked \`${truncate(word, 60)}\` → **${action}**.`);
      return;
    }

    if (sub === "remove") {
      const word = interaction.options.getString("word", true).trim().toLowerCase();
      const res = await AutoModWord.deleteOne({ guildId, word });
      if (res.deletedCount === 0) {
        await interaction.editReply(`\`${truncate(word, 60)}\` is not blocked.`);
        return;
      }
      await interaction.editReply(`✅ Unblocked \`${truncate(word, 60)}\`.`);
      return;
    }

    if (sub === "toggle") {
      const word = interaction.options.getString("word", true).trim().toLowerCase();
      const enabled = interaction.options.getBoolean("enabled", true);
      const res = await AutoModWord.updateOne({ guildId, word }, { $set: { enabled } });
      if (res.matchedCount === 0) {
        await interaction.editReply(`\`${truncate(word, 60)}\` is not blocked.`);
        return;
      }
      await interaction.editReply(`${enabled ? "🟢 Enabled" : "🔴 Disabled"} \`${truncate(word, 60)}\`.`);
      return;
    }

    const docs = await AutoModWord.find({ guildId }).sort({ createdAt: -1 }).limit(30);
    if (docs.length === 0) {
      await interaction.editReply("No blocked words yet. Add one with `/automod add`.");
      return;
    }
    const lines = docs.map(
      (d) => `- ${d.enabled ? "🟢" : "🔴"} \`${truncate(d.word, 60)}\` → ${d.action}${d.action === "timeout" ? ` (${d.timeoutSec}s)` : ""}`,
    );
    await interaction.editReply(`**Blocked words**\n${lines.join("\n")}`);
  },
};

const onMessageCreate = async (_client: Client, message: Message): Promise<void> => {
  if (!message.inGuild() || message.author.bot || !message.content || !message.member) return;
  if (message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
  const rules = await AutoModWord.find({ guildId: message.guildId, enabled: true });
  if (rules.length === 0) return;
  const hit = rules.find((r) => matchesWord(message.content, r.word));
  if (!hit) return;

  await message.delete().catch(() => undefined);
  if (hit.action === "timeout" && message.member.moderatable) {
    await message.member
      .timeout(hit.timeoutSec * 1000, `Automod: blocked word "${hit.word}"`)
      .catch(() => undefined);
  }
  try {
    const warn = await message.channel.send({
      content: `${message.author}, that word is not allowed here.`,
    });
    setTimeout(() => warn.delete().catch(() => undefined), 5000).unref?.();
  } catch {
    // channel may be read-only – the delete already happened
  }
};

export const automodModule: Module = {
  name: "automod",
  description: "Custom word filter with delete/timeout actions",
  defaultEnabled: true,
  commands: [automodCommand],
  events: [{ name: "messageCreate", run: onMessageCreate }],
};
