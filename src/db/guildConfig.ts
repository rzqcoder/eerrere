import { GuildConfig, type IGuildConfig } from "./models";

const cache = new Map<string, { doc: IGuildConfig; at: number }>();
const TTL_MS = 15_000;

/** Cached per-guild config (upserts an empty doc on first access). Pass fresh:true after writes. */
export async function getGuildConfig(guildId: string, opts: { fresh?: boolean } = {}): Promise<IGuildConfig> {
  const cached = cache.get(guildId);
  if (cached && !opts.fresh && Date.now() - cached.at < TTL_MS) return cached.doc;
  const doc = await GuildConfig.findOneAndUpdate(
    { guildId },
    { $setOnInsert: { guildId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
  cache.set(guildId, { doc, at: Date.now() });
  return doc;
}

export function invalidateGuildConfig(guildId: string): void {
  cache.delete(guildId);
}

export function isModuleEnabled(cfg: IGuildConfig, moduleName: string, defaultEnabled = true): boolean {
  const enabled = cfg.enabledModules?.get(moduleName);
  if (enabled === undefined) return defaultEnabled;
  return enabled;
}
