import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  Client,
  ClientEvents,
  ModalSubmitInteraction,
  RESTPostAPIApplicationCommandsJSONBody,
  SlashCommandBuilder,
  StringSelectMenuInteraction,
} from "discord.js";

/** Anything with a name plus toJSON (covers SlashCommandBuilder and subcommand builders). */
export interface CommandDataLike {
  name: string;
  toJSON(): RESTPostAPIApplicationCommandsJSONBody;
}

export type CommandData = SlashCommandBuilder | CommandDataLike;

export type ComponentPayload =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | ModalSubmitInteraction;

export interface ModuleCommand {
  data: CommandData;
  /** Anyone in an allowed guild may run it when true; otherwise ACCESS_ROLE_IDS whitelist applies. */
  public?: boolean;
  run: (client: Client, interaction: ChatInputCommandInteraction) => Promise<void> | void;
}

export interface ModuleEvent {
  name: keyof ClientEvents;
  run: (client: Client, ...args: any[]) => Promise<void> | void;
}

export interface ModuleInteraction {
  /** Custom id (exact) or prefix before an optional ":suffix". */
  customId: string;
  public?: boolean;
  run: (client: Client, interaction: ComponentPayload) => Promise<void> | void;
}

export interface Module {
  name: string;
  description: string;
  defaultEnabled?: boolean;
  commands?: ModuleCommand[];
  events?: ModuleEvent[];
  interactions?: ModuleInteraction[];
}
