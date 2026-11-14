import { SlashCommandBuilder, type Client, type ChatInputCommandInteraction } from "discord.js";
import { EPHEMERAL, errMessage, makeEmbed } from "../core/util";
import { rconExec } from "../rcon";
import { MCDaily } from "../db/models";
import { NAME_RE, clean } from "./minecraft";
import type { Module, ModuleCommand } from "../core/types";

/* ------------------------------------ /daily ----------------------------------- */

const DAY_MS = 86_400_000;
/** day 1→6 payout; day 6+ keeps paying the max. Day 4 = 2500 (user-confirmed). */
const REWARDS = [500, 1000, 2000, 2500, 3000, 4000];
const rewardFor = (day: number): number => (day >= REWARDS.length ? REWARDS[REWARDS.length - 1] : REWARDS[day - 1]);

/** Per-discord-id claim lock so a double-click can't pay out twice. */
const claimLock = new Map<string, number>();

const dailyCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("daily")
    .setDescription("Claim your daily in-game money (streaks increase the reward)")
    .addStringOption((o) =>
      o.setName("username").setDescription("Your Minecraft username (saved after first use)").setRequired(false).setMaxLength(16),
    ),
  public: true, // players use this one
  run: async (_client: Client, interaction: ChatInputCommandInteraction): Promise<void> => {
    await interaction.deferReply({ flags: EPHEMERAL });
    try {
      const uid = interaction.user.id;
      const doc = await MCDaily.findOne({ discordId: uid }).exec();
      const opt = interaction.options.getString("username");
      let mcName: string;
      if (opt) {
        mcName = clean(opt);
        if (!NAME_RE.test(mcName)) throw new Error("That is not a valid Minecraft username.");
      } else if (doc?.mcName) {
        mcName = doc.mcName;
      } else {
        await interaction.editReply({
          content: "🎮 First time? Run `/daily username: <your Minecraft name>` — it's saved for next time.",
        });
        return;
      }

      const now = Date.now();
      const last = doc?.lastClaimAt ? doc.lastClaimAt.getTime() : 0;
      if (last && now - last < DAY_MS) {
        await interaction.editReply({ content: `⏳ Already claimed! Next reward in **${formatLeft(now - last)}**.` });
        return;
      }
      const held = claimLock.get(uid);
      if (held && now - held < DAY_MS) return;
      claimLock.set(uid, now);

      // Streak continues within 48h of the last claim; a gap longer resets to day 1.
      const day = !last ? 1 : now - last <= 2 * DAY_MS ? (doc?.day ?? 1) + 1 : 1;
      const reward = rewardFor(day);

      try {
        await rconExec(`eco give ${mcName} ${reward}`);
      } catch (err) {
        claimLock.delete(uid); // failed payout must not burn the cooldown
        throw err;
      }

      await MCDaily.findOneAndUpdate(
        { discordId: uid },
        { discordId: uid, mcName, day, lastClaimAt: new Date(now), $inc: { totalClaimed: reward } },
        { upsert: true },
      ).exec();

      const embed = makeEmbed()
        .setTitle("🎁 Daily reward claimed!")
        .setDescription(
          `Day **${day}**${day >= REWARDS.length ? " (max)" : ""} — **$${reward.toLocaleString("en-US")}** sent to \`${mcName}\`.`,
        )
        .addFields(
          { name: "Streak", value: `${day} day${day === 1 ? "" : "s"}`, inline: true },
          { name: "Next claim", value: `<t:${Math.floor((now + DAY_MS) / 1000)}:R>`, inline: true },
        );
      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      await interaction.editReply({ content: `❌ ${errMessage(err)}` }).catch(() => undefined);
    } finally {
      // Lock is cleared only on failure paths (kept on success so the 24h cooldown holds
      // even if the DB row write somehow lagged); timeout naturally expires it.
    }
  },
};

const formatLeft = (elapsed: number): string => {
  const left = DAY_MS - elapsed;
  const h = Math.floor(left / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
};

export const dailyModule: Module = {
  name: "daily",
  description: "Daily in-game money claims with streaks (24h cooldown)",
  defaultEnabled: true,
  commands: [dailyCommand],
};
