import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type Client,
  type GuildMember,
  type VoiceBasedChannel,
} from "discord.js";
import { Player, QueryType, type GuildQueue } from "discord-player";
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
      const result = await player.play(voice, query, {
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

      const line = `**${truncate(track.title, 150)}** — \`${track.duration}\`${track.url ? ` • <${track.url}>` : ""}`;
      if (queue.size === 0) {
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
