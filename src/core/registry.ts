import { Events, type ChatInputCommandInteraction, type Interaction } from "discord.js";
import { client } from "./client";
import { modules } from "../modules";
import { metaFor } from "./moduleMeta";
import { bumpCommandStat } from "../db/commandStats";
import { getGuildConfig, isModuleEnabled } from "../db/guildConfig";
import { hasAccessRole, isAllowedGuild } from "./guards";
import { safeReply } from "./util";
import type { CommandData, ComponentPayload, ModuleCommand, ModuleEvent, ModuleInteraction } from "./types";
import { ALLOWED_GUILD_IDS } from "../env";

interface CommandEntry {
  moduleName: string;
  data: CommandData;
  isPublic: boolean;
  run: ModuleCommand["run"];
}

const commandMap = new Map<string, CommandEntry>();
const interactions: ModuleInteraction[] = [];
const events: ModuleEvent[] = [];

interface ComponentModuleInteraction extends ModuleInteraction {
  moduleName: string;
}

const componentEntries: ComponentModuleInteraction[] = [];

export function initRegistry(): void {
  for (const mod of modules) {
    for (const command of mod.commands ?? []) {
      commandMap.set(command.data.name, {
        moduleName: mod.name,
        data: command.data,
        isPublic: command.public ?? false,
        run: command.run,
      });
    }
    for (const event of mod.events ?? []) events.push(event);
    for (const inter of mod.interactions ?? []) {
      componentEntries.push({ ...inter, moduleName: mod.name });
    }
  }

  for (const event of events) {
    client.on(event.name as any, (...args: any[]) => {
      void Promise.resolve(event.run(client, ...args)).catch((err) =>
        console.error(`[event:${String(event.name)}]`, err),
      );
    });
  }

  client.on(Events.InteractionCreate, (interaction) => {
    void onInteraction(interaction).catch((err) => console.error("[interaction]", err));
  });

  client.once(Events.ClientReady, () => {
    void registerCommands().catch((err) => console.error("[commands] registration failed:", err));
  });
}

async function onInteraction(interaction: Interaction): Promise<void> {
  if (interaction.isChatInputCommand()) {
    await handleCommand(interaction);
  } else if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    await handleComponent(interaction);
  }
}

async function handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!isAllowedGuild(interaction.guildId)) return;
  const entry = commandMap.get(interaction.commandName);
  if (!entry) return;
  if (!interaction.inCachedGuild()) return;

  const cfg = await getGuildConfig(interaction.guildId);
  const defaultEnabled = metaFor(entry.moduleName)?.defaultEnabled ?? true;
  if (!isModuleEnabled(cfg, entry.moduleName, defaultEnabled)) {
    await safeReply(interaction, `The **${entry.moduleName}** module is disabled in this server.`);
    return;
  }
  if (!entry.isPublic && !hasAccessRole(interaction)) {
    await safeReply(interaction, "You do not have permission to use this command.");
    return;
  }

  try {
    await entry.run(client, interaction);
    void bumpCommandStat(interaction.guildId, interaction.commandName, interaction.user.id);
  } catch (err) {
    console.error(`[command:${interaction.commandName}]`, err);
    await safeReply(interaction, "Something went wrong running that command.");
  }
}

async function handleComponent(
  interaction: ComponentPayload,
): Promise<void> {
  if (!isAllowedGuild(interaction.guildId)) return;
  const entry = componentEntries.find(
    (e) => interaction.customId === e.customId || interaction.customId.startsWith(`${e.customId}:`),
  );
  if (!entry) return;
  if (!interaction.inCachedGuild()) return;

  const cfg = await getGuildConfig(interaction.guildId);
  const defaultEnabled = metaFor(entry.moduleName)?.defaultEnabled ?? true;
  if (!isModuleEnabled(cfg, entry.moduleName, defaultEnabled)) {
    await safeReply(interaction, `The **${entry.moduleName}** module is disabled in this server.`);
    return;
  }
  if (!entry.public && !hasAccessRole(interaction)) {
    await safeReply(interaction, "You do not have permission to use this.");
    return;
  }

  try {
    await entry.run(client, interaction);
  } catch (err) {
    console.error(`[interaction:${interaction.customId}]`, err);
    await safeReply(interaction, "Something went wrong handling that interaction.");
  }
}

async function registerCommands(): Promise<void> {
  const payload = [...commandMap.values()].map((entry) => entry.data.toJSON());
  for (const guildId of ALLOWED_GUILD_IDS) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      console.warn(`[commands] bot is not in allowed guild ${guildId} yet`);
      continue;
    }
    try {
      await guild.commands.set(payload);
      console.log(`[commands] registered ${payload.length} commands in ${guild.name}`);
    } catch (err) {
      console.error(`[commands] failed to register in ${guild.name}:`, err);
    }
  }
}
