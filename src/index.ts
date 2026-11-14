import { connectDB } from "./db";
import { env } from "./env"; // Changed from ./src/env to ./env

async function main(): Promise<void> {
  console.log(`[bot] starting Novax Guard (${env.NODE_ENV})...`);
  await connectDB();
  const { client } = await import("./core/client");
  const { initRegistry } = await import("./core/registry");
  initRegistry();
  await client.login(env.DISCORD_TOKEN);
}

main().catch((err) => {
  console.error("[bot] fatal startup error:", err);
  process.exit(1);
});
