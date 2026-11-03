# Novax Guard

A modular Discord bot for Bun + TypeScript + MongoDB. Every feature lives in its own module under `src/modules/`, is wired by a central registry (`src/core/registry.ts`), and can be enabled/disabled per server with `/modules`.

## Requirements

- [Bun](https://bun.sh) 1.3+ (`bun --version`)
- MongoDB (local `mongod` or an Atlas URI)

## Setup

1. **Install**

   ```bash
   bun install
   ```

2. **Configure** – copy `.env.example` to `.env` and fill it in:

   ```bash
   cp .env.example .env
   ```

   | Key | Meaning |
   | --- | --- |
   | `DISCORD_TOKEN` | Bot token from the Developer Portal |
   | `MONGODB_URI` | Mongo connection string |
   | `ALLOWED_GUILD_IDS` | Comma-separated server IDs the bot is allowed in (commands register instantly in these servers on startup) |
   | `ACCESS_ROLE_IDS` | Comma-separated role IDs allowed to use non-public commands (empty = everyone; admins always allowed) |
   | `PORT` | Port for the built-in health server (Render injects `PORT` automatically; default `3007`) |
   | `STATUS_TOKEN` | Optional secret protecting `GET /status` (`Authorization: Bearer <token>`) |
   | `NODE_ENV` / `LOG_LEVEL` | Optional |

3. **Prerequisites in Discord** – the bot needs these *Privileged Gateway Intents* in the Developer Portal because the modules use them:
   - **Server Members** – anti-raid, bot-join protection, member logs
   - **Message Content** – anti-spam, anti-link, auto-responder, analytics

4. **Run**

   ```bash
   bun run dev      # watch mode
   bun run start    # production
   bun run typecheck
   ```

Slash commands are registered automatically on startup for every server in `ALLOWED_GUILD_IDS`. No separate deploy step.

## Health endpoint (open port)

The bot starts a small HTTP server **before** anything else so your host always has a port to connect to:

| Route | Purpose |
| --- | --- |
| `GET /` or `GET /health` | Liveness JSON — use as the Render **health check path** |
| `GET /status` | Detailed status (DB, bot user, guild count, WS ping, memory). Add `Authorization: Bearer <STATUS_TOKEN>` if `STATUS_TOKEN` is set |

It binds `0.0.0.0:$PORT` (Render sets `PORT` for you; locally it defaults to `3007`).

```bash
curl localhost:3007/health   # local check
```

## Modules

| Module | Commands | What it does |
| --- | --- | --- |
| `core` | `/ping` `/help` `/info` `/modules` | Status, help browser, per-guild module toggles |
| `utility` | `/snipe` `/userinfo` `/serverinfo` `/poll` `/remind` `/tag` `/role` `/nick` | Last deleted message, member/server details, reaction polls, DM reminders, server tags, role & nickname management |
| `security` | `/security` | Anti-spam (delete + strike timeouts), anti-raid (alerts + optional auto-lockdown), anti-link with domain allowlist, bot-join protection, manual lockdown |
| `automod` | `/automod` | Blocked word/phrase list with delete or delete+timeout actions |
| `music` | `/play` `/skip` `/prev` `/pause` `/stop` `/shuffle` `/volume` `/queue` `/nowplaying` | Voice player via discord-player: SoundCloud/Spotify/Apple Music links or search, queue, progress bar |
| `moderation` | `/mod` | ban/unban, kick, timeout/untimeout, warn, numbered cases, purge, slowmode |
| `logging` | `/logging` | Route `message-delete/edit`, `member-join/leave/roles`, `role-changes`, `channel-changes`, `voice`, `bans`, `moderation` to channels |
| `giveaways` | `/giveaway` | 🎉 reaction giveaways; scheduled ending via a sweeper, rerolls, list |
| `reactionroles` | `/rr` | Bind emojis on any message to roles; optional "one role at a time" mode |
| `autoresponder` | `/ar` | exact / contains / regex triggers with per-user cooldowns |
| `tempvoice` | `/vc` | Join-to-create voice channels: claim, lock/unlock, permit/deny, rename |
| `embeds` | `/embed` `/say` | In-memory embed builder (modal) and plain announcements |
| `tickets` | `/ticket` | Setup + panel, open with a button, claim, close, HTML transcript to a log channel |
| `analytics` | `/top` `/stats` | Message and voice leaderboards plus `/top commands` usage stats |
| `backups` | `/backup` `/backupload` `/backupdelete` | Snapshot and restore missing roles/channels (names/types/colors/bitrate – not permissions or messages) |

Public commands (`/ping`, `/help`, `/info`, `/top`, `/stats`, ticket buttons) skip the `ACCESS_ROLE_IDS` whitelist but still require the server to be in `ALLOWED_GUILD_IDS`. Everything else checks the whitelist (admin override).

## Architecture

```
src/
  index.ts            # entrypoint: connect Mongo, init registry, login
  env.ts              # zod-validated env + ALLOWED_GUILD_IDS / ACCESS_ROLE_IDS
  core/
    client.ts         # the single Discord client + presence
    config.ts         # branding, colors, presence
    guards.ts         # guild whitelist + role whitelist helpers
    health.ts         # HTTP health/status server on $PORT
    moduleMeta.ts     # static module list for /help + /modules
    registry.ts       # aggregates all modules, routes commands/events/interactions
    types.ts          # ModuleCommand / ModuleEvent / ModuleInteraction / Module
    util.ts           # safeReply, duration parsing, embed helpers
  db/
    connect.ts        # mongoose connection
    models.ts         # GuildConfig, Ticket, Giveaway, AutoResponder, ReactionRole,
                      # ModCase, UserStats, CommandStat, TempVoice, Backup
    guildConfig.ts    # cached per-guild config util
    commandStats.ts   # /top commands counting
  modules/            # one file per feature module (see table above)
```

To add a module: create `src/modules/<name>.ts` exporting a `Module` (commands + events + interactions), add it to the array in `src/modules/index.ts`, and add a meta entry in `src/core/moduleMeta.ts` so `/modules` and `/help` list it.

## Notes

- Giveaway end detection uses a 30s sweeper, so wins are announced even after restarts.
- Voice minutes are computed from `lastVoiceJoinAt` in Mongo, so they survive restarts.
- Anti-spam/id trackers are in-memory per process (fast); config itself lives in Mongo.
- Tickets generate full HTML transcripts into the configured log channel via `discord-html-transcripts`.
