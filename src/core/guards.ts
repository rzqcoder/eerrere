import { PermissionFlagsBits, type BaseInteraction } from "discord.js";
import { ACCESS_ROLE_IDS, ALLOWED_GUILD_IDS } from "../env";

export function isAllowedGuild(guildId: string | null | undefined): boolean {
  if (!guildId) return false;
  if (ALLOWED_GUILD_IDS.length === 0) return false;
  return ALLOWED_GUILD_IDS.includes(guildId);
}

/**
 * True when the member satisfies the ACCESS_ROLE_IDS whitelist.
 * Empty whitelist = no restriction. Administrators always pass.
 */
export function hasAccessRole(interaction: BaseInteraction): boolean {
  if (ACCESS_ROLE_IDS.length === 0) return true;
  if (!interaction.inCachedGuild()) return false;
  const member = interaction.member;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return member.roles.cache.some((role) => ACCESS_ROLE_IDS.includes(role.id));
}

/** Staff check combining whitelist roles, admin perms, and optional per-guild staff roles. */
export function isStaff(interaction: BaseInteraction, staffRoleIds: string[] = []): boolean {
  if (hasAccessRole(interaction)) return true;
  if (!interaction.inCachedGuild()) return false;
  const member = interaction.member;
  return staffRoleIds.some((id) => member.roles.cache.has(id));
}
