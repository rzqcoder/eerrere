import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Client,
  type GuildMember,
  type VoiceBasedChannel,
} from "discord.js";
import { Player, QueryType, type GuildQueue, type Track } from "discord-player";
import { DefaultExtractors } from "@discord-player/extractor";
import { EPHEMERAL, truncate } from "../core/util";
import { config } from "../core/config";
import type { Module, ModuleCommand, ModuleEvent } from "../core/types";

/** Queue metadata we stash so events know where to talk. */
interface MusicMeta {
  channelId?: string;
}

let playerInstance: Player | null = null;
let extractorsLoaded = false;
let eventsBound = false;

function getPlayer(client: Client): Player {
  if (!playerInstance) {
    playerInstance = Player.create(client, { connectionTimeout: 30_000 });
  }
  return playerInstance;
}

async function ensurePlayer(client: Client): Promise<Player> {
  const player = getPlayer(client);
  if (!extractorsLoaded) {
    extractorsLoaded = true;
    await player.extractors.loadMulti(DefaultExtractors);
  }
  if (!eventsBound) {
    eventsBound = true;
    player.events.on("playerError", (queue, error) => {
      console.error("[music] player error:", error);
      const channelId = (queue.metadata as MusicMeta | null)?.channelId;
      const channel = channelId ? queue.guild.channels.cache.get(channelId) : null;
      if (channel && "send" in channel) {
        void (channel as any)
          .send({ content: `⚠️ Playback error: ${truncate(error.message, 300)}` })
          .catch(() => undefined);
      }
    });
    player.events.on("disconnect", (queue) => {
      console.log(`[music] disconnected from voice in guild ${queue.id}`);
    });
  }
  return player;
}

function requireVoice(member: GuildMember): VoiceBasedChannel {
  const voice = member.voice.channel;
  if (!voice) throw new Error("Join a voice channel first.");
  return voice;
}

function requireQueue(player: Player, guildId: string | null): GuildQueue<MusicMeta> {
  const queue = guildId ? player.queues.get(guildId) : null;
  if (!queue) throw new Error("Nothing is queued right now. Use `/play` first.");
  return queue;
}

/* -------------------------------------- play ---------------------------------------- */

/** Spotify / Apple Music links: metadata resolves, but their audio can't be streamed
 *  directly (discord-player v7 has no YouTube bridge) — we look the song up on
 *  SoundCloud by title/artist instead. */
const STREAMING_LINK_RE = /^(?:https?:\/\/)?(?:open\.spotify\.com|music\.apple\.com)\/\S+/i;

/** "4:35" / "1:02:03" → seconds; null when unparseable (e.g. "Live"). */
function parseDurationSec(duration: string): number | null {
  const parts = duration.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  let total = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n)) return null;
    total = total * 60 + n;
  }
  return total;
}

/**
 * Pick the SoundCloud result that best matches the original track:
 * title/author token overlap first, then closest duration (avoids30s previews
 * and wrong songs that happen to have the same length).
 */
export function pickBestMatch(candidates: Track[], target: Track): Track | null {
  if (candidates.length === 0) return null;
  const targetSec = parseDurationSec(target.duration);
  const tokens = `${target.title} ${target.author}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

  const scored = candidates.map((t) => {
    const hay = `${t.title} ${t.description ?? ""}`.toLowerCase();
    const overlap = tokens.length
      ? tokens.filter((w) => hay.includes(w)).length / tokens.length
      : 1;
    return { t, overlap, sec: parseDurationSec(t.duration) };
  });

  const viable = scored.filter((s) => s.overlap >= 0.5);
  const pool = viable.length > 0 ? viable : scored;
  if (targetSec == null) return pool[0]?.t ?? candidates[0]!;

  let best = pool[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const s of pool) {
    if (s.sec == null) continue;
    const score = Math.abs(s.sec - targetSec) + (1 - s.overlap) * targetSec * 0.5;
    if (score < bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best.t;
}

const playCommand: ModuleCommand = {
  public: true,
  data: new SlashCommandBuilder()
    .setName("play")
    .setDescription("Play music in a voice channel")
    .addStringOption((opt) =>
      opt
        .setName("query")
        .setDescription("Song name, or a SoundCloud / Spotify / Apple Music link")
        .setRequired(true)
        .setMaxLength(500),
    ),
  run: async (client, interaction) => {
    if (!interaction.inCachedGuild()) throw new Error("This command can only be used in a server.");
    const voice = requireVoice(interaction.member);
    const me = interaction.guild.members.me;
    if (me && !voice.permissionsFor(me).has([PermissionFlagsBits.Connect, PermissionFlagsBits.Speak])) {
      throw new Error(`I need **Connect** and **Speak** permissions in **${voice.name}**.`);
    }

    const player = await ensurePlayer(client);
    const existing = player.queues.get(interaction.guildId);
    if (existing?.channel && existing.channel.id !== voice.id) {
      throw new Error(`I'm already playing in **${existing.channel.name}** — join that channel or wait for me to leave.`);
    }

    await interaction.deferReply();
    const query = interaction.options.getString("query", true);
    try {
      let target: string | Track = query;
      let extras: Track[] = [];

      if (STREAMING_LINK_RE.test(query.trim())) {
        const meta = await player.search(query, { requestedBy: interaction.user }).catch(() => null);
        if (!meta || meta.tracks.length === 0) {
          await interaction.editReply("❌ Could not read that Spotify/Apple Music link.");
          return;
        }
        const wanted = meta.playlist ? meta.tracks.slice(0, 20) : meta.tracks.slice(0, 1);
        const resolved: Track[] = [];
        for (const t of wanted) {
          const r = await player
            .search(`${t.title} ${t.author}`.trim(), {
              requestedBy: interaction.user,
              fallbackSearchEngine: QueryType.SOUNDCLOUD_SEARCH,
            })
            .catch(() => null);
          const match = r ? pickBestMatch(r.tracks, t) : null;
          if (match) resolved.push(match);
        }
        if (resolved.length === 0) {
          await interaction.editReply(
            "❌ I could read the track info, but found no playable match on SoundCloud. Try searching by name instead.",
          );
          return;
        }
        target = resolved[0]!;
        extras = resolved.slice(1);
      }

      const result = await player.play(voice, target, {
        requestedBy: interaction.user,
        fallbackSearchEngine: QueryType.SOUNDCLOUD_SEARCH,
        nodeOptions: {
          metadata: { channelId: interaction.channelId } satisfies MusicMeta,
          volume: 80,
          leaveOnEmpty: true,
          leaveOnEmptyCooldown: 60_000,
          leaveOnEnd: true,
          leaveOnEndCooldown: 60_000,
          leaveOnStop: true,
          selfDeaf: true,
          maxSize: 200,
        },
      });
      const { track, queue } = result;
      // keep announcements pointed at the channel that issued the latest /play
      queue.metadata = { channelId: interaction.channelId } satisfies MusicMeta;
      if (extras.length > 0) queue.addTrack(extras);

      const line = `**${truncate(track.title, 150)}** — \`${track.duration}\`${track.url ? ` • <${track.url}>` : ""}`;
      if (extras.length > 0) {
        await interaction.editReply(
          `🎵 Spotify/Apple Music link → SoundCloud match. Now playing ${line} (+${extras.length} more from the playlist).`,
        );
      } else if (queue.size === 0) {
        await interaction.editReply(`▶️ Now playing ${line}`);
      } else {
        await interaction.editReply(`➕ Added at **#${queue.size}** in the queue: ${line}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await interaction.editReply(`❌ Could not play that: ${truncate(msg, 400)}`);
    }
  },
};

/* ------------------------------------- controls ------------------------------------- */

const skipCommand: ModuleCommand = {
  public: true,
  data: new SlashCommandBuilder().setName("skip").setDescription("Skip the current track"),
  run: async (client, interaction) => {
    const queue = requireQueue(await ensurePlayer(client), interaction.guildId);
    if (!queue.isPlaying()) throw new Error("Nothing is playing.");
    const ok = queue.node.skip();
    await interaction.reply({ content: ok ? "⏭ Skipped." : "Could not skip that track.", flags: EPHEMERAL });
  },
};

const prevCommand: ModuleCommand = {
  public: true,
  data: new SlashCommandBuilder().setName("prev").setDescription("Play the previous track"),
  run: async (client, interaction) => {
    const queue = requireQueue(await ensurePlayer(client), interaction.guildId);
    if (queue.history.isEmpty()) throw new Error("There is no previous track.");
    await queue.history.back();
    await interaction.reply({ content: "⏮ Playing the previous track.", flags: EPHEMERAL });
  },
};

const pauseCommand: ModuleCommand = {
  public: true,
  data: new SlashCommandBuilder().setName("pause").setDescription("Pause or resume playback"),
  run: async (client, interaction) => {
    const queue = requireQueue(await ensurePlayer(client), interaction.guildId);
    if (!queue.isPlaying()) throw new Error("Nothing is playing.");
    if (queue.node.isPaused()) {
      queue.node.resume();
      await interaction.reply({ content: "▶️ Resumed.", flags: EPHEMERAL });
    } else {
      queue.node.pause();
      await interaction.reply({ content: "⏸ Paused.", flags: EPHEMERAL });
    }
  },
};

const stopCommand: ModuleCommand = {
  data: new SlashCommandBuilder().setName("stop").setDescription("Stop playback and clear the queue"),
  run: async (client, interaction) => {
    const queue = requireQueue(await ensurePlayer(client), interaction.guildId);
    queue.clear();
    queue.node.stop(true);
    await interaction.reply({ content: "⏹ Stopped and cleared the queue.", flags: EPHEMERAL });
  },
};

const shuffleCommand: ModuleCommand = {
  data: new SlashCommandBuilder().setName("shuffle").setDescription("Shuffle the queue"),
  run: async (client, interaction) => {
    const queue = requireQueue(await ensurePlayer(client), interaction.guildId);
    if (queue.tracks.size < 2) throw new Error("Not enough tracks in the queue to shuffle.");
    queue.tracks.shuffle();
    await interaction.reply({ content: `🔀 Shuffled **${queue.tracks.size}** tracks.`, flags: EPHEMERAL });
  },
};

const volumeCommand: ModuleCommand = {
  data: new SlashCommandBuilder()
    .setName("volume")
    .setDescription("Show or set the playback volume")
    .addIntegerOption((opt) =>
      opt.setName("level").setDescription("Volume 0-100 (omit to show current)").setMinValue(0).setMaxValue(100),
    ),
  run: async (client, interaction) => {
    const queue = requireQueue(await ensurePlayer(client), interaction.guildId);
    const level = interaction.options.getInteger("level");
    if (level === null) {
      await interaction.reply({ content: `🔊 Volume: **${queue.node.volume}%**`, flags: EPHEMERAL });
      return;
    }
    queue.node.setVolume(level);
    await interaction.reply({ content: `🔊 Volume set to **${level}%**.`, flags: EPHEMERAL });
  },
};

/* -------------------------------------- views --------------------------------------- */

const queueCommand: ModuleCommand = {
  public: true,
  data: new SlashCommandBuilder().setName("queue").setDescription("Show the current queue"),
  run: async (client, interaction) => {
    const queue = requireQueue(await ensurePlayer(client), interaction.guildId);
    const current = queue.currentTrack;
    const upcoming = queue.tracks.data;

    const lines: string[] = [];
    if (current) {
      lines.push(
        `▶️ **${truncate(current.title, 150)}** — \`${current.duration}\`${current.url ? ` • <${current.url}>` : ""}`,
      );
    }
    if (upcoming.length === 0) {
      lines.push("\n*Nothing else in the queue.*");
    } else {
      lines.push("", "**Up next:**");
      for (const [i, track] of upcoming.slice(0, 10).entries()) {
        const by = track.requestedBy ? ` • <@${track.requestedBy.id}>` : "";
        lines.push(`\`${i + 1}.\` ${truncate(track.title, 100)} — \`${track.duration}\`${by}`);
      }
      if (upcoming.length > 10) lines.push(`*…and ${upcoming.length - 10} more*`);
      lines.push("", `**${upcoming.length}** track(s) queued.`);
    }

    const embed = new EmbedBuilder()
      .setColor(config.embedColors.primary)
      .setTitle(`Queue — ${interaction.guild?.name ?? ""}`)
      .setDescription(lines.join("\n").slice(0, 4000));
    await interaction.reply({ embeds: [embed], flags: EPHEMERAL });
  },
};

const nowPlayingCommand: ModuleCommand = {
  public: true,
  data: new SlashCommandBuilder().setName("nowplaying").setDescription("Show the track that is playing now"),
  run: async (client, interaction) => {
    const queue = requireQueue(await ensurePlayer(client), interaction.guildId);
    const track = queue.currentTrack;
    if (!track || !queue.isPlaying()) throw new Error("Nothing is playing.");

    const ts = queue.node.getTimestamp();
    const bar = queue.node.createProgressBar({ length: 20, timecodes: true });
    const embed = new EmbedBuilder()
      .setColor(config.embedColors.primary)
      .setTitle(`🎵 ${truncate(track.title, 200)}`)
      .setURL(track.url || null)
      .setThumbnail(track.thumbnail || null)
      .addFields(
        { name: "Duration", value: ts ? `${ts.current.label} / ${ts.total.label}` : track.duration, inline: true },
        { name: "Requested by", value: track.requestedBy ? `<@${track.requestedBy.id}>` : "unknown", inline: true },
        { name: "Source", value: truncate(String(track.queryType ?? "unknown"), 100), inline: true },
      );
    if (bar) embed.setDescription(bar);
    await interaction.reply({ embeds: [embed], flags: EPHEMERAL });
  },
};

/* ------------------------------------- module --------------------------------------- */

const initMusic: ModuleEvent = {
  name: "clientReady",
  run: async (client) => {
    await ensurePlayer(client);
    console.log("[music] discord-player ready (SoundCloud/Spotify/Apple Music/Vimeo)");
  },
};

export const musicModule: Module = {
  name: "music",
  description: "Voice music player with queue, controls and playlists",
  defaultEnabled: true,
  commands: [
    playCommand,
    skipCommand,
    prevCommand,
    pauseCommand,
    stopCommand,
    shuffleCommand,
    volumeCommand,
    queueCommand,
    nowPlayingCommand,
  ],
  events: [initMusic],
};
