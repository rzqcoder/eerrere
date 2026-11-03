import mongoose, { Schema } from "mongoose";

/* ---------------------------------- Guild config ---------------------------------- */

export interface IGuildConfig {
  guildId: string;
  ownerId?: string;
  enabledModules?: Map<string, boolean>;
  logChannels?: Map<string, string>;
  nextCaseNumber?: number;
  security?: {
    antiSpam?: { enabled?: boolean; threshold?: number; windowSec?: number; timeoutSec?: number };
    antiRaid?: { enabled?: boolean; threshold?: number; windowSec?: number; lockdownSec?: number; alertChannelId?: string };
    antiLink?: { enabled?: boolean; allowlist?: string[] };
    botProtection?: { enabled?: boolean; allowlist?: string[]; action?: "kick" | "ban" };
  };
  tickets?: { categoryId?: string; staffRoleIds?: string[]; transcriptChannelId?: string; nextNumber?: number };
  tempVoice?: { joinChannelId?: string; categoryId?: string; nameTemplate?: string };
}

const guildConfigSchema = new Schema<IGuildConfig>(
  {
    guildId: { type: String, required: true, unique: true, index: true },
    ownerId: String,
    enabledModules: { type: Map, of: Boolean, default: {} },
    logChannels: { type: Map, of: String, default: {} },
    nextCaseNumber: { type: Number, default: 0 },
    security: {
      antiSpam: { enabled: Boolean, threshold: Number, windowSec: Number, timeoutSec: Number },
      antiRaid: { enabled: Boolean, threshold: Number, windowSec: Number, lockdownSec: Number, alertChannelId: String },
      antiLink: { enabled: Boolean, allowlist: [String] },
      botProtection: { enabled: Boolean, allowlist: [String], action: String },
    },
    tickets: {
      categoryId: String,
      staffRoleIds: [String],
      transcriptChannelId: String,
      nextNumber: { type: Number, default: 1 },
    },
    tempVoice: { joinChannelId: String, categoryId: String, nameTemplate: String },
  },
  { minimize: false, versionKey: false },
);

/* ------------------------------------- Tickets ------------------------------------- */

export interface ITicket {
  _id?: mongoose.Types.ObjectId;
  guildId: string;
  number: number;
  channelId: string;
  ownerId: string;
  status: "open" | "closed";
  claimedBy?: string;
  closedBy?: string;
  closedAt?: Date;
  createdAt: Date;
}

const ticketSchema = new Schema<ITicket>(
  {
    guildId: { type: String, required: true, index: true },
    number: { type: Number, required: true },
    channelId: { type: String, required: true },
    ownerId: { type: String, required: true, index: true },
    status: { type: String, enum: ["open", "closed"], default: "open", index: true },
    claimedBy: String,
    closedBy: String,
    closedAt: Date,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
ticketSchema.index({ channelId: 1 }, { unique: true });

/* ------------------------------------- Giveaways ------------------------------------ */

export interface IGiveaway {
  _id?: mongoose.Types.ObjectId;
  guildId: string;
  channelId: string;
  messageId: string;
  hostId: string;
  prize: string;
  winnerCount: number;
  participants: string[];
  winners: string[];
  status: "open" | "ended";
  endsAt: Date;
  endedAt?: Date;
  createdAt: Date;
}

const giveawaySchema = new Schema<IGiveaway>(
  {
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    messageId: { type: String, required: true },
    hostId: { type: String, required: true },
    prize: { type: String, required: true },
    winnerCount: { type: Number, default: 1 },
    participants: { type: [String], default: [] },
    winners: { type: [String], default: [] },
    status: { type: String, enum: ["open", "ended"], default: "open", index: true },
    endsAt: { type: Date, required: true, index: true },
    endedAt: Date,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

/* ---------------------------------- Auto responders --------------------------------- */

export interface IAutoResponder {
  _id?: mongoose.Types.ObjectId;
  guildId: string;
  trigger: string;
  matchType: "exact" | "contains" | "regex";
  response: string;
  enabled: boolean;
  cooldownSec: number;
  createdBy?: string;
  createdAt: Date;
}

const autoResponderSchema = new Schema<IAutoResponder>(
  {
    guildId: { type: String, required: true, index: true },
    trigger: { type: String, required: true },
    matchType: { type: String, enum: ["exact", "contains", "regex"], default: "contains" },
    response: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    cooldownSec: { type: Number, default: 0 },
    createdBy: String,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);

/* ----------------------------------- Reaction roles --------------------------------- */

export interface IReactionRoleBinding {
  key: string; // emoji id for custom emojis, emoji name for unicode
  roleId: string;
}

export interface IReactionRole {
  _id?: mongoose.Types.ObjectId;
  guildId: string;
  channelId: string;
  messageId: string;
  unique: boolean;
  bindings: IReactionRoleBinding[];
  createdAt: Date;
}

const reactionRoleSchema = new Schema<IReactionRole>(
  {
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    messageId: { type: String, required: true },
    unique: { type: Boolean, default: false },
    bindings: [
      {
        key: { type: String, required: true },
        roleId: { type: String, required: true },
      },
    ],
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
reactionRoleSchema.index({ messageId: 1 }, { unique: true });

/* ------------------------------------- Mod cases ------------------------------------ */

export interface IModCase {
  _id?: mongoose.Types.ObjectId;
  guildId: string;
  caseId: number;
  type: "ban" | "unban" | "kick" | "timeout" | "untimeout" | "warn";
  targetUserId: string;
  targetTag?: string;
  moderatorId: string;
  reason?: string;
  durationMs?: number;
  createdAt: Date;
}

const modCaseSchema = new Schema<IModCase>(
  {
    guildId: { type: String, required: true, index: true },
    caseId: { type: Number, required: true },
    type: { type: String, required: true },
    targetUserId: { type: String, required: true, index: true },
    targetTag: String,
    moderatorId: { type: String, required: true },
    reason: String,
    durationMs: Number,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
modCaseSchema.index({ guildId: 1, caseId: 1 }, { unique: true });

/* ------------------------------------- User stats ----------------------------------- */

export interface IUserStats {
  guildId: string;
  userId: string;
  messages: number;
  voiceMinutes: number;
  lastMessageAt?: Date;
  lastVoiceJoinAt?: Date;
  createdAt: Date;
}

const userStatsSchema = new Schema<IUserStats>(
  {
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    messages: { type: Number, default: 0 },
    voiceMinutes: { type: Number, default: 0 },
    lastMessageAt: Date,
    lastVoiceJoinAt: Date,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
userStatsSchema.index({ guildId: 1, userId: 1 }, { unique: true });

/* ------------------------------------ Command stats --------------------------------- */

export interface ICommandStat {
  guildId: string;
  commandName: string;
  userId: string;
  count: number;
  lastUsedAt: Date;
}

const commandStatSchema = new Schema<ICommandStat>(
  {
    guildId: { type: String, required: true, index: true },
    commandName: { type: String, required: true },
    userId: { type: String, required: true },
    count: { type: Number, default: 1 },
    lastUsedAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
commandStatSchema.index({ guildId: 1, commandName: 1, userId: 1 }, { unique: true });

/* --------------------------------------- Temp voices -------------------------------- */

export interface ITempVoice {
  _id?: mongoose.Types.ObjectId;
  guildId: string;
  channelId: string;
  ownerId: string;
  locked?: boolean;
  deniedUserIds?: string[];
  createdAt: Date;
}

const tempVoiceSchema = new Schema<ITempVoice>(
  {
    guildId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    ownerId: { type: String, required: true },
    locked: { type: Boolean, default: false },
    deniedUserIds: { type: [String], default: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
tempVoiceSchema.index({ channelId: 1 }, { unique: true });

/* --------------------------------------- Backups ------------------------------------ */

export interface IBackupRole {
  name: string;
  color: number;
  hoist: boolean;
  mentionable: boolean;
  permissions: string;
}

export interface IBackupChannel {
  oldId: string;
  name: string;
  type: number;
  parentId?: string | null;
  topic?: string | null;
  bitrate?: number;
  userLimit?: number;
  nsfw?: boolean;
  rateLimit?: number;
}

export interface IBackup {
  _id?: mongoose.Types.ObjectId;
  guildId: string;
  name: string;
  createdBy: string;
  data: { roles: IBackupRole[]; channels: IBackupChannel[] };
  createdAt: Date;
}

const backupSchema = new Schema<IBackup>(
  {
    guildId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    createdBy: String,
    data: { roles: [], channels: [] },
    createdAt: { type: Date, default: Date.now },
  },
  { minimize: false, versionKey: false },
);

/* --------------------------------------- Reminders ---------------------------------- */

export interface IReminder {
  _id?: mongoose.Types.ObjectId;
  guildId: string;
  userId: string;
  channelId: string;
  content: string;
  dueAt: Date;
  sentAt?: Date;
  createdAt: Date;
}

const reminderSchema = new Schema<IReminder>(
  {
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    channelId: { type: String, required: true },
    content: { type: String, required: true },
    dueAt: { type: Date, required: true, index: true },
    sentAt: Date,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
reminderSchema.index({ sentAt: 1, dueAt: 1 });

/* ----------------------------------------- Tags ------------------------------------- */

export interface ITag {
  _id?: mongoose.Types.ObjectId;
  guildId: string;
  name: string;
  content: string;
  createdBy: string;
  uses: number;
  createdAt: Date;
}

const tagSchema = new Schema<ITag>(
  {
    guildId: { type: String, required: true, index: true },
    name: { type: String, required: true },
    content: { type: String, required: true },
    createdBy: { type: String, required: true },
    uses: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
tagSchema.index({ guildId: 1, name: 1 }, { unique: true });

/* ----------------------------------- AutoMod words ---------------------------------- */

export interface IAutoModWord {
  _id?: mongoose.Types.ObjectId;
  guildId: string;
  word: string;
  action: "delete" | "timeout";
  timeoutSec: number;
  enabled: boolean;
  addedBy?: string;
  createdAt: Date;
}

const autoModWordSchema = new Schema<IAutoModWord>(
  {
    guildId: { type: String, required: true, index: true },
    word: { type: String, required: true },
    action: { type: String, enum: ["delete", "timeout"], default: "delete" },
    timeoutSec: { type: Number, default: 60 },
    enabled: { type: Boolean, default: true },
    addedBy: String,
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false },
);
autoModWordSchema.index({ guildId: 1, word: 1 }, { unique: true });

/* --------------------------------------- Models ------------------------------------- */

export const GuildConfig = mongoose.model<IGuildConfig>("GuildConfig", guildConfigSchema, "guildconfigs");
export const Ticket = mongoose.model<ITicket>("Ticket", ticketSchema, "tickets");
export const Giveaway = mongoose.model<IGiveaway>("Giveaway", giveawaySchema, "giveaways");
export const AutoResponder = mongoose.model<IAutoResponder>("AutoResponder", autoResponderSchema, "autoresponders");
export const ReactionRole = mongoose.model<IReactionRole>("ReactionRole", reactionRoleSchema, "reactionroles");
export const ModCase = mongoose.model<IModCase>("ModCase", modCaseSchema, "modcases");
export const UserStats = mongoose.model<IUserStats>("UserStats", userStatsSchema, "userstats");
export const CommandStat = mongoose.model<ICommandStat>("CommandStat", commandStatSchema, "commandstats");
export const TempVoice = mongoose.model<ITempVoice>("TempVoice", tempVoiceSchema, "tempvoices");
export const Backup = mongoose.model<IBackup>("Backup", backupSchema, "backups");
export const Reminder = mongoose.model<IReminder>("Reminder", reminderSchema, "reminders");
export const Tag = mongoose.model<ITag>("Tag", tagSchema, "tags");
export const AutoModWord = mongoose.model<IAutoModWord>("AutoModWord", autoModWordSchema, "automodwords");


