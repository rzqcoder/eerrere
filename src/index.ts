import { connectDB } from "./db";
import { env } from "./env";
import { startHealthServer } from "./core/health";

async function main(): Promise<void> {
  // Open the HTTP port first so the host can connect immediately (health checks,
  // uptime monitors) even while Mongo/Discord are still starting.
  startHealthServer();
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
