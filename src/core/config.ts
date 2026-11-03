import { ActivityType } from "discord.js";

export const config = {
  name: "Novax Guard",
  version: "1.0.0",
  embedColors: {
    primary: 0x5865f2,
    success: 0x57f287,
    danger: 0xed4245,
    warning: 0xfee75c,
  },
  presence: {
    status: "online" as const,
    type: ActivityType.Streaming,
    name: "/help",
    url: "https://www.twitch.tv/novax",
  },
};
