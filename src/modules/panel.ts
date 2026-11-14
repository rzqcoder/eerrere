import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type ChatInputCommandInteraction,
} from "discord.js";
import { MC_ALLOWED_USER_IDS } from "../env";
import { EPHEMERAL, errMessage, formatDuration, makeEmbed, parseDuration, relTime, safeReply, truncate } from "../core/util";
import { rconExec } from "../rcon";
import { NAME_RE, clean, doTempban, doTempbanIp, isIpv4, plain } from "./minecraft";
import type { ComponentPayload, Module, ModuleCommand, ModuleInteraction } from "../core/types";

const isOwner = (id: string): boolean => MC_ALLOWED_USER_IDS.includes(id);

const result = (title: string, out: string) =>
  makeEmbed().setTitle(title).setDescription(out ? truncate(out, 900) : "Done (server gave no output).");

const needDur = (raw: string): number => {
  const ms = parseDuration(clean(raw));
  if (!ms || ms < 30_000) throw new Error("Invalid duration. Use `10m`, `2h`, `7d` (min 30s).");
  if (ms > 365 * 86_400_000) throw new Error("Maximum duration is 365 days.");
  return ms;
};

/** Compact Essentials-style duration: 1d2h30m / 45m / 30s (spaces are not parsed reliably). */
const essDur = (ms: number): string => {
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const out = `${d ? `${d}d` : ""}${h ? `${h}h` : ""}${m ? `${m}m` : ""}${!d && !h ? `${s}s` : ""}`;
  return out || "0s";
};

const btn = (id: string, label: string, style: ButtonStyle, emoji: string): ButtonBuilder =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setEmoji(emoji).setStyle(style);

const actionRows = (name: string): ActionRowBuilder<ButtonBuilder>[] => [
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    btn(`panel:act:ban:${name}`, "Ban", ButtonStyle.Danger, "🔨"),
    btn(`panel:act:kick:${name}`, "Kick", ButtonStyle.Danger, "👢"),
    btn(`panel:act:banip:${name}`, "IP Ban", ButtonStyle.Danger, "🚫"),
    btn(`panel:act:tempban:${name}`, "Tempban", ButtonStyle.Secondary, "⏳"),
    btn(`panel:act:tempbanip:${name}`, "IP Tempban", ButtonStyle.Secondary, "⏳"),
  ),
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    btn(`panel:act:mute:${name}`, "Mute", ButtonStyle.Secondary, "🔇"),
    btn("panel:close", "Close", ButtonStyle.Primary, "❌"),
  ),
];

const durModal = (action: string, name: string): ModalBuilder => {
  const title = action === "tempban" ? "Tempban" : action === "tempbanip" ? "IP Tempban" : "Mute";
  const m = new ModalBuilder()
    .setCustomId(`panel:dur:${action}:${name}`)
    .setTitle(`${title} — ${truncate(name, 24)}`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("dur")
          .setLabel("Duration")
          .setPlaceholder("e.g. 10m, 2h, 7d")
          .setRequired(true)
          .setMaxLength(20)
          .setStyle(TextInputStyle.Short),
      ),
    );
  if (action === "tempbanip") {
    m.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("ip")
          .setLabel("IPv4 address to ban")
          .setPlaceholder("1.2.3.4")
          .setRequired(true)
          .setMaxLength(64)
          .setStyle(TextInputStyle.Short),
      ),
    );
  }
  return m;
};

const panelCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Minecraft control panel: pick a player, act with buttons (owner-only)"),
  // public: registry role-gate skipped; owner allowlist inside run() is the real gate.
  public: true,
  run: async (_client: Client, interaction: ChatInputCommandInteraction): Promise<void> => {
    if (!isOwner(interaction.user.id)) {
      await interaction.reply({ content: "⛔ Only the server owners can open the control panel.", flags: EPHEMERAL }).catch(() => undefined);
      return;
    }
    await interaction.deferReply({ flags: EPHEMERAL });
    const embed = makeEmbed()
      .setTitle("🛠 Minecraft Control Panel")
      .setDescription("Pick a player to see their avatar, then act with one click:\nban · kick · ban-ip · tempban · tempban-ip · mute")
      .setFooter({ text: "Only you (owner allowlist) can use this panel." });
    await interaction.editReply({
      embeds: [embed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(btn("panel:pick", "Choose player", ButtonStyle.Success, "✏️"))],
    });
  },
};

/** One handler for all `panel:*` buttons and modals (registry matches the `panel` prefix). */
const panelInteraction: ModuleInteraction = {
  customId: "panel",
  public: true, // owner allowlist checked below
  run: async (_client: Client, interaction: ComponentPayload): Promise<void> => {
    if (!isOwner(interaction.user.id)) {
      await safeReply(interaction, "⛔ Only the server owners can use the control panel.");
      return;
    }
    try {
      const parts = interaction.customId.split(":");
      const kind = parts[1] ?? "";

      // Button: open the username modal
      if (interaction.isButton() && kind === "pick") {
        const modal = new ModalBuilder()
          .setCustomId("panel:player")
          .setTitle("Choose player")
          .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setCustomId("name")
                .setLabel("Minecraft username")
                .setPlaceholder("e.g. Notch")
                .setRequired(true)
                .setMaxLength(16)
                .setStyle(TextInputStyle.Short),
            ),
          );
        await interaction.showModal(modal);
        return;
      }

      // Modal: username entered → action buttons with avatar
      if (interaction.isModalSubmit() && kind === "player") {
        const name = clean(interaction.fields.getTextInputValue("name"));
        if (!NAME_RE.test(name)) {
          await interaction.reply({ content: "❌ Not a valid Minecraft username.", flags: EPHEMERAL });
          return;
        }
        const embed = makeEmbed()
          .setTitle(`🎮 ${name}`)
          .setDescription("Choose an action — temp/mute actions ask for a duration.")
          .setThumbnail(`https://mc-heads.net/avatar/${encodeURIComponent(name)}/64`);
        await interaction.reply({ embeds: [embed], components: actionRows(name), flags: EPHEMERAL });
        return;
      }

      // Button: instant action (ban/kick/banip) or open duration modal
      if (interaction.isButton() && kind === "act") {
        const action = parts[2] ?? "";
        const name = parts[3] ?? "";
        if (!NAME_RE.test(name)) throw new Error("Invalid player in panel state.");
        if (action === "tempban" || action === "tempbanip" || action === "mute") {
          await interaction.showModal(durModal(action, name));
          return;
        }
        await interaction.deferUpdate();
        let title: string;
        let cmd: string;
        if (action === "ban") {
          cmd = `ban ${name} Banned via control panel`;
          title = `🔨 Banned ${name}`;
        } else if (action === "kick") {
          cmd = `kick ${name} Kicked via control panel`;
          title = `👢 Kicked ${name}`;
        } else if (action === "banip") {
          cmd = `ban-ip ${name} IP banned via control panel`;
          title = `🚫 IP-banned ${name}`;
        } else {
          throw new Error("Unknown panel action.");
        }
        const out = plain(await rconExec(cmd));
        await interaction.editReply({ embeds: [result(title, out)], components: [] });
        return;
      }

      // Modal: duration (and IP for tempbanip) → scheduled/executed action
      if (interaction.isModalSubmit() && kind === "dur") {
        const action = parts[2] ?? "";
        const name = parts[3] ?? "";
        if (!NAME_RE.test(name)) throw new Error("Invalid player in panel state.");
        await interaction.deferReply({ flags: EPHEMERAL });
        const ms = needDur(interaction.fields.getTextInputValue("dur"));
        let title: string;
        let desc: string;
        if (action === "tempban") {
          const unbanAt = await doTempban(name, ms, "Tempbanned via control panel", interaction.user.id);
          title = `🔨 Tempbanned ${name}`;
          desc = `Unbans ${relTime(unbanAt)} (${formatDuration(ms)}).`;
        } else if (action === "tempbanip") {
          const ip = clean(interaction.fields.getTextInputValue("ip"));
          if (!isIpv4(ip)) throw new Error("Not a valid IPv4 address.");
          const unbanAt = await doTempbanIp(ip, ms, "Tempbanned via control panel", interaction.user.id);
          title = `🔨 Tempbanned IP ${ip}`;
          desc = `Unbans ${relTime(unbanAt)} (${formatDuration(ms)}).`;
        } else if (action === "mute") {
          const e = essDur(ms);
          title = `🔇 Muted ${name} (${e})`;
          desc = plain(await rconExec(`mute ${name} ${e}`));
        } else {
          throw new Error("Unknown panel action.");
        }
        await interaction.editReply({ embeds: [makeEmbed().setTitle(title).setDescription(desc ? truncate(desc, 900) : "Done.")] });
        return;
      }

      // Button: close
      if (interaction.isButton() && kind === "close") {
        await interaction.update({ content: "Panel closed.", embeds: [], components: [] });
        return;
      }
    } catch (err) {
      await safeReply(interaction, `❌ ${errMessage(err)}`);
    }
  },
};

export const panelModule: Module = {
  name: "panel",
  description: "Private admin panel: avatar lookup + one-click ban/kick/tempban/mute buttons",
  defaultEnabled: true,
  commands: [panelCommand],
  interactions: [panelInteraction],
};
