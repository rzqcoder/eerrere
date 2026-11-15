/**
 * Static module registry used by /help and /modules.
 * Keep names in sync with the modules array in src/modules/index.ts.
 */
export interface ModuleMeta {
  name: string;
  description: string;
  defaultEnabled: boolean;
  commands: string[];
}

export const moduleMeta: ModuleMeta[] = [
  { name: "core", description: "Ping, help, info and module management", defaultEnabled: true, commands: ["ping", "help", "info", "modules"] },
  { name: "security", description: "Anti-spam, anti-raid, anti-link, bot protection, lockdown", defaultEnabled: true, commands: ["security"] },
  { name: "moderation", description: "Bans, kicks, timeouts, warnings, cases, purge", defaultEnabled: true, commands: ["mod"] },
  { name: "logging", description: "Server events logged into configurable channels", defaultEnabled: true, commands: ["logging"] },
  { name: "giveaways", description: "Reaction-based giveaways", defaultEnabled: true, commands: ["giveaway"] },
  { name: "reactionroles", description: "Emoji reaction role bindings", defaultEnabled: true, commands: ["rr"] },
  { name: "autoresponder", description: "Trigger-to-response automation", defaultEnabled: true, commands: ["ar"] },
  { name: "tempvoice", description: "Join-to-create temporary voice channels", defaultEnabled: true, commands: ["vc"] },
  { name: "embeds", description: "Embed builder and announcements", defaultEnabled: true, commands: ["embed", "say"] },
  { name: "tickets", description: "Ticket panels with claiming and transcripts", defaultEnabled: true, commands: ["ticket"] },
  { name: "analytics", description: "Message/voice leaderboards and stats", defaultEnabled: true, commands: ["top", "stats"] },
  { name: "backups", description: "Server structure backups", defaultEnabled: true, commands: ["backup", "backupload", "backupdelete"] },
  { name: "minecraft", description: "Minecraft server control over RCON (owner-only)", defaultEnabled: true, commands: ["mc"] },
  { name: "status", description: "Live status message + rotating presence (players, TPS, CPU/RAM)", defaultEnabled: true, commands: ["status"] },
  { name: "daily", description: "Daily in-game money claims with streaks", defaultEnabled: true, commands: ["daily"] },
  { name: "events", description: "In-game event triggers: boss spawn (owner-only)", defaultEnabled: true, commands: ["boss"] },
  { name: "panel", description: "Minecraft control panel with one-click actions (owner-only)", defaultEnabled: true, commands: ["panel"] },
];

export const metaFor = (name: string): ModuleMeta | undefined => moduleMeta.find((m) => m.name === name);
