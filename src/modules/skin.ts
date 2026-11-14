import { SlashCommandBuilder, AttachmentBuilder, type Client, type ChatInputCommandInteraction } from "discord.js";
import { EPHEMERAL, errMessage, makeEmbed } from "../core/util";
import { NAME_RE, clean } from "./minecraft";
import type { Module, ModuleCommand } from "../core/types";

/* Skin sources tried in order — if Render can't reach one host, fall back to the next. */
const SOURCES: { label: string; url: (n: string, s: number) => string }[] = [
  { label: "mc-heads", url: (n, s) => `https://mc-heads.net/avatar/${n}/${s}` },
  { label: "crafatar", url: (n, s) => `https://crafatar.com/avatars/${n}?size=${s}` },
  { label: "minotar", url: (n, s) => `https://minotar.net/helm/${n}/${s}.png` },
];

/** PNG or JPEG magic bytes — guards against HTML/error pages served with 200. */
const isImage = (b: Buffer): boolean =>
  (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) ||
  (b[0] === 0xff && b[1] === 0xd8);

/** First source that returns a real image; throws with every failure reason if all fail. */
async function fetchSkin(name: string, size: number): Promise<{ buf: Buffer; source: string }> {
  const errs: string[] = [];
  for (const src of SOURCES) {
    try {
      const res = await fetch(src.url(encodeURIComponent(name), size), { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        errs.push(`${src.label}: HTTP ${res.status}`);
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 64 || !isImage(buf)) {
        errs.push(`${src.label}: not an image`);
        continue;
      }
      return { buf, source: src.label };
    } catch (err) {
      errs.push(`${src.label}: ${errMessage(err)}`);
    }
  }
  throw new Error(`Couldn't fetch that skin — ${errs.join(" · ").slice(0, 300)}`);
}

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
      const { buf, source } = await fetchSkin(name, size);
      const file = new AttachmentBuilder(buf, { name: "skin.png" });
      const embed = makeEmbed()
        .setTitle(`🎨 ${name}'s skin`)
        .setImage("attachment://skin.png")
        .setFooter({ text: `${size}px · ${source}` });
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
