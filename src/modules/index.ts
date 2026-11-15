import { coreModule } from "./core";
import { securityModule } from "./security";
import { moderationModule } from "./moderation";
import { loggingModule } from "./logging";
import { giveawaysModule } from "./giveaways";
import { reactionRolesModule } from "./reactionroles";
import { autoresponderModule } from "./autoresponder";
import { tempVoiceModule } from "./tempvoice";
import { embedsModule } from "./embeds";
import { ticketsModule } from "./tickets";
import { analyticsModule } from "./analytics";
import { backupsModule } from "./backups";
import { minecraftModule } from "./minecraft";
import { statusModule } from "./status";
import { dailyModule } from "./daily";
import { eventsModule } from "./events";
import { panelModule } from "./panel";
import type { Module } from "../core/types";

/**
 * All feature modules. Names must match src/core/moduleMeta.ts.
 * Order only affects init order; each module's commands/events/interactions
 * are wired by src/core/registry.ts.
 */
export const modules: Module[] = [
  coreModule,
  securityModule,
  moderationModule,
  loggingModule,
  giveawaysModule,
  reactionRolesModule,
  autoresponderModule,
  tempVoiceModule,
  embedsModule,
  ticketsModule,
  analyticsModule,
  backupsModule,
  minecraftModule,
  statusModule,
  dailyModule,
  eventsModule,
  panelModule,
];
