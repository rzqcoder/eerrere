import { SlashCommandBuilder, AttachmentBuilder, type Client, type ChatInputCommandInteraction } from "discord.js";
import { EPHEMERAL, errMessage, makeEmbed } from "../core/util";
import { NAME_RE, clean } from "./minecraft";
import type { Module, ModuleCommand } from "../core/types";

const skinCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("skin")
    .setDescription("Show a Minecraft player's current skin")
    .addStringOption((o) => o.setName("username").setDescription("Minecraft username").setRequired(true).setMaxLength(16))
    .addIntegerOption((o) =>
      o
        .setName("size")
        .setDescription("Image size (default 128)")
        .addChoices(
          { name: "64px", value: 64 },
          { name: "128px", value: 128 },
          { name: "256px", value: 256 },
        ),
    ),
  public: true, // usable by everyone; no admin data exposed
  run: async (_client: Client, interaction: ChatInputCommandInteraction): Promise<void> => {
    await interaction.deferReply({ flags: EPHEMERAL });
    try {
      const name = clean(interaction.options.getString("username") ?? "");
      if (!NAME_RE.test(name)) throw new Error("That is not a valid Minecraft username.");
      const size = interaction.options.getInteger("size") ?? 128;
      const res = await fetch(`https://mc-heads.net/avatar/${encodeURIComponent(name)}/${size}`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error("Couldn't fetch that player's skin (name not found?).");
      const buf = Buffer.from(await res.arrayBuffer());
      const file = new AttachmentBuilder(buf, { name: "skin.png" });
      const embed = makeEmbed()
        .setTitle(`🎨 ${name}'s skin`)
        .setImage("attachment://skin.png")
        .setFooter({ text: `${size}px · mc-heads.net` });
      await interaction.editReply({ embeds: [embed], files: [file] });
    } catch (err) {
      await interaction.editReply({ content: `❌ ${errMessage(err)}` }).catch(() => undefined);
    }
  },
};

export const skinModule: Module = {
  name: "skin",
  description: "Look up any Minecraft player's skin in Discord",
  defaultEnabled: true,
  commands: [skinCommand],
};
