import { CommandStat } from "./models";

export async function bumpCommandStat(guildId: string, commandName: string, userId: string): Promise<void> {
  try {
    await CommandStat.updateOne(
      { guildId, commandName, userId },
      { $inc: { count: 1 }, $set: { lastUsedAt: new Date() } },
      { upsert: true },
    );
  } catch (err) {
    console.error("[stats] failed to bump command stat", err);
  }
}
