import { EmbedBuilder, MessageFlags, SlashCommandBuilder } from "discord.js";
import { config } from "../core/config";
import { AutoResponder, type IAutoResponder } from "../db/models";
import { EPHEMERAL, makeEmbed, truncate } from "../core/util";
import type { Module, ModuleCommand, ModuleInteraction } from "../core/types";

const responderCooldowns = new Map<string, number>();

function matchesTrigger(doc: IAutoResponder, content: string): boolean {
  const text = content.trim();
  switch (doc.matchType) {
    case "exact":
      return text.toLowerCase() === doc.trigger.trim().toLowerCase();
    case "contains":
      return text.toLowerCase().includes(doc.trigger.toLowerCase());
    case "regex":
      try {
        return new RegExp(doc.trigger, "i").test(text);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

const arCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("ar")
    .setDescription("Auto responder configuration")
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("Add a trigger-response pair")
        .addStringOption((opt) => opt.setName("trigger").setDescription("What the bot looks for").setRequired(true))
        .addStringOption((opt) => opt.setName("response").setDescription("What the bot replies with").setRequired(true))
        .addStringOption((opt) =>
          opt
            .setName("mode")
            .setDescription("Match mode (default contains)")
            .addChoices(
              { name: "contains", value: "contains" },
              { name: "exact", value: "exact" },
              { name: "regex", value: "regex" },
            ),
        )
        .addIntegerOption((opt) =>
          opt.setName("cooldown").setDescription("Cooldown per user in seconds (default 0)").setMinValue(0).setMaxValue(3600),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("Remove a responder")
        .addStringOption((opt) => opt.setName("trigger").setDescription("Trigger to remove").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("toggle")
        .setDescription("Enable or disable a responder")
        .addStringOption((opt) => opt.setName("trigger").setDescription("Trigger to toggle").setRequired(true))
        .addBooleanOption((opt) => opt.setName("enabled").setDescription("New state").setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName("list").setDescription("List all responders")),
  run: async (_client, interaction) => {
    await interaction.deferReply({ flags: EPHEMERAL });
    const guildId = interaction.guildId;
    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      const trigger = interaction.options.getString("trigger", true).slice(0, 500);
      const response = interaction.options.getString("response", true).slice(0, 1900);
      const matchType = (interaction.options.getString("mode") ?? "contains") as IAutoResponder["matchType"];
      const cooldownSec = interaction.options.getInteger("cooldown") ?? 0;
      if (matchType === "regex") {
        try {
          new RegExp(trigger, "i");
        } catch {
          await interaction.editReply("That regex is invalid.");
          return;
        }
      }
      const existing = await AutoResponder.findOne({ guildId, trigger, matchType });
      if (existing) {
        await AutoResponder.updateOne({ _id: existing._id }, { $set: { response, cooldownSec, enabled: true } });
        await interaction.editReply(`Updated the existing **${matchType}** responder for \`${truncate(trigger, 80)}\`.`);
        return;
      }
      await AutoResponder.create({
        guildId,
        trigger,
        matchType,
        response,
        cooldownSec,
        enabled: true,
        createdBy: interaction.user.id,
        createdAt: new Date(),
      });
      await interaction.editReply(`Added **${matchType}** responder: \`${truncate(trigger, 80)}\`.`);
      return;
    }

    if (sub === "remove") {
      const trigger = interaction.options.getString("trigger", true);
      const res = await AutoResponder.deleteOne({ guildId, trigger });
      if (res.deletedCount === 0) {
        await interaction.editReply("No responder found with that exact trigger.");
        return;
      }
      await interaction.editReply(`Removed responder \`${truncate(trigger, 80)}\`.`);
      return;
    }

    if (sub === "toggle") {
      const trigger = interaction.options.getString("trigger", true);
      const enabled = interaction.options.getBoolean("enabled", true);
      const res = await AutoResponder.updateOne({ guildId, trigger }, { $set: { enabled } });
      if (res.matchedCount === 0) {
        await interaction.editReply("No responder found with that exact trigger.");
        return;
      }
      await interaction.editReply(`${enabled ? "🟢 Enabled" : "🔴 Disabled"} \`${truncate(trigger, 80)}\`.`);
      return;
    }

    if (sub === "list") {
      const docs = await AutoResponder.find({ guildId }).sort({ createdAt: -1 }).limit(20);
      if (docs.length === 0) {
        await interaction.editReply("No responders yet. Add one with `/ar add`.");
        return;
      }
      const lines = docs.map(
        (d) =>
          `- \`${d.matchType}\` ${d.enabled ? "🟢" : "🔴"} **${truncate(d.trigger, 60)}** → ${truncate(d.response, 120)}${d.cooldownSec ? ` (cooldown ${d.cooldownSec}s)` : ""}`,
      );
      const embed = new EmbedBuilder()
        .setColor(config.embedColors.primary)
        .setTitle("Auto responders")
        .setDescription(lines.join("\n").slice(0, 4000));
      await interaction.editReply({ embeds: [embed] });
      return;
    }
  },
};

const onMessageCreate = async (
  client: Parameters<ModuleInteraction["run"]>[0],
  message: { guildId: string | null; guild: { id: string } | null; author: { bot: boolean; id: string }; content: string; reply: (payload: unknown) => Promise<unknown> },
): Promise<void> => {
  if (!message.guildId || message.author?.bot || !message.content) return;
  const docs = await AutoResponder.find({ guildId: message.guildId, enabled: true });
  if (docs.length === 0) return;
  for (const doc of docs) {
    if (!matchesTrigger(doc, message.content)) continue;
    if (doc.cooldownSec > 0) {
      const key = `${doc._id}:${message.author.id}`;
      const nextAllowed = responderCooldowns.get(key) ?? 0;
      const now = Date.now();
      if (now < nextAllowed) continue;
      responderCooldowns.set(key, now + doc.cooldownSec * 1000);
    }
    await message.reply(doc.response).catch(() => undefined);
    return; // only the first matching responder runs
  }
};

export const autoresponderModule: Module = {
  name: "autoresponder",
  description: "Trigger-to-response automation",
  defaultEnabled: true,
  commands: [arCommand],
  events: [{ name: "messageCreate", run: onMessageCreate }],
};

