import { coreModule } from "./core";
import { utilityModule } from "./utility";
import { securityModule } from "./security";
import { automodModule } from "./automod";
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
import type { Module } from "../core/types";

/**
 * All feature modules. Names must match src/core/moduleMeta.ts.
 * Order only affects init order; each module's commands/events/interactions
 * are wired by src/core/registry.ts.
 */
export const modules: Module[] = [
  coreModule,
  utilityModule,
  securityModule,
  automodModule,
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
];
