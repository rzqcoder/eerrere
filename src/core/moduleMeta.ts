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
  { name: "utility", description: "Snipe, user/server info, polls, reminders, tags, roles, nicknames", defaultEnabled: true, commands: ["snipe", "userinfo", "serverinfo", "poll", "remind", "tag", "role", "nick"] },
  { name: "security", description: "Anti-spam, anti-raid, anti-link, bot protection, lockdown", defaultEnabled: true, commands: ["security"] },
  { name: "automod", description: "Custom word filter with delete/timeout actions", defaultEnabled: true, commands: ["automod"] },
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
];

export const metaFor = (name: string): ModuleMeta | undefined => moduleMeta.find((m) => m.name === name);
