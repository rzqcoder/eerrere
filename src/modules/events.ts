import { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client, type ChatInputCommandInteraction } from "discord.js";
import { MC_ALLOWED_USER_IDS, MC_BOSS_COMMANDS } from "../env";
import { EPHEMERAL, errMessage, makeEmbed, truncate } from "../core/util";
import { rconExec } from "../rcon";
import { plain } from "./minecraft";
import type { ComponentPayload, Module, ModuleCommand, ModuleInteraction } from "../core/types";

const isOwner = (id: string): boolean => MC_ALLOWED_USER_IDS.includes(id);

/** Runs every configured boss command in order; returns a summary of each output. */
async function runBoss(): Promise<string> {
  if (MC_BOSS_COMMANDS.length === 0) {
    throw new Error("No boss commands configured — set MC_BOSS_COMMANDS in .env (comma-separated console commands).");
  }
  const lines: string[] = [];
  for (const cmd of MC_BOSS_COMMANDS) {
    const out = plain(await rconExec(cmd, 6000));
    lines.push(`\`${truncate(cmd, 120)}\` → ${out ? truncate(out, 400) : "ok"}`);
  }
  return lines.join("\n");
}

const bossEmbed = (output: string, again: boolean): ReturnType<typeof makeEmbed> =>
  makeEmbed()
    .setTitle("💀 Boss spawned")
    .setDescription(output)
    .setFooter({ text: again ? "Click the button to spawn again." : "Spawned via control panel" });

const spawnButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId("boss:again").setLabel("Spawn again").setEmoji("🚀").setStyle(ButtonStyle.Danger),
);

const bossCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("boss")
    .setDescription("In-game event triggers (owner-only)")
    .addSubcommand((s) => s.setName("spawn").setDescription("Spawn the boss (runs the configured console commands)")),
  // public: registry role-gate skipped; owner allowlist inside run() is the real gate.
  public: true,
  run: async (_client: Client, interaction: ChatInputCommandInteraction): Promise<void> => {
    if (!isOwner(interaction.user.id)) {
      await interaction
        .reply({ content: "⛔ Only the server owners can trigger events.", flags: EPHEMERAL })
        .catch(() => undefined);
      return;
    }
    await interaction.deferReply({ flags: EPHEMERAL });
    try {
      const out = await runBoss();
      await interaction.editReply({ embeds: [bossEmbed(out, true)], components: [spawnButton] });
    } catch (err) {
      await interaction.editReply({ content: `❌ ${errMessage(err)}` }).catch(() => undefined);
    }
  },
};

/** "Spawn again" button on the boss embed. */
const againInteraction: ModuleInteraction = {
  customId: "boss",
  public: true, // owner allowlist checked below
  run: async (_client: Client, interaction: ComponentPayload): Promise<void> => {
    if (!isOwner(interaction.user.id)) {
      await interaction.reply({ content: "⛔ Only the server owners can trigger events.", flags: EPHEMERAL }).catch(() => undefined);
      return;
    }
    if (!interaction.isButton()) return;
    await interaction.deferUpdate();
    try {
      const out = await runBoss();
      await interaction.editReply({ embeds: [bossEmbed(out, true)], components: [spawnButton] });
    } catch (err) {
      await interaction.editReply({ embeds: [makeEmbed().setTitle("❌ Boss spawn failed").setDescription(errMessage(err))] }).catch(
        () => undefined,
      );
    }
  },
};

export const eventsModule: Module = {
  name: "events",
  description: "In-game event triggers: one-click console routines (boss spawn)",
  defaultEnabled: true,
  commands: [bossCommand],
  interactions: [againInteraction],
};
