import { Client, Events, IntentsBitField, Partials } from "discord.js";
import { config } from "./config";
import { env } from "../env";

export const client = new Client({
  intents: [
    IntentsBitField.Flags.Guilds,
    IntentsBitField.Flags.GuildMembers,
    IntentsBitField.Flags.GuildMessages,
    IntentsBitField.Flags.MessageContent,
    IntentsBitField.Flags.GuildModeration,
    IntentsBitField.Flags.GuildVoiceStates,
    IntentsBitField.Flags.GuildPresences,
    IntentsBitField.Flags.GuildMessageReactions,
  ],
  partials: [
    Partials.Message,
    Partials.Channel,
    Partials.GuildMember,
    Partials.Reaction,
    Partials.ThreadMember,
  ],
});

export const startupAt = Date.now();

client.once(Events.ClientReady, () => {
  console.log(`[bot] logged in as ${client.user?.tag}`);
  // Never let presence setup throw: a throwing listener would stop the other
  // ClientReady listeners (status module's rotating presence) from running.
  try {
    client.user?.setPresence({
      status: config.presence.status,
      activities: [
        {
          name: config.presence.name,
          type: config.presence.type,
          url: config.presence.url,
        },
      ],
    });
  } catch (err) {
    console.error("[bot] initial presence failed:", err);
  }
});
