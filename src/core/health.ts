import mongoose from "mongoose";
import { config } from "./config";
import { env } from "../env";
import { client } from "./client";

/**
 * Tiny HTTP server so your host (Render, VPS, health monitors) has an open port to
 * connect to as soon as the process starts — before the Discord login even finishes.
 *
 *   GET /        → tiny liveness JSON
 *   GET /health  → same as / (use this as the Render health-check path)
 *   GET /status  → detailed status; requires `Authorization: Bearer <STATUS_TOKEN>` if set
 *
 * Bound on 0.0.0.0:$PORT so it is reachable from outside the container.
 */

const DB_STATES: Record<number, string> = {
  0: "disconnected",
  1: "connected",
  2: "connecting",
  3: "disconnecting",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function startHealthServer(): void {
  const startedAt = Date.now();
  const uptimeSec = () => Math.floor((Date.now() - startedAt) / 1000);

  try {
    Bun.serve({
      port: env.PORT,
      hostname: "0.0.0.0", // reachable from outside the machine/container
      fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "GET" && req.method !== "HEAD") {
          return json({ ok: false, error: "method not allowed" }, 405);
        }

        const path = url.pathname.replace(/\/+$/, "") || "/";

        if (path === "/" || path === "/health") {
          return json({
            ok: true,
            service: config.name,
            version: config.version,
            uptimeSec: uptimeSec(),
          });
        }

        if (path === "/status") {
          if (env.STATUS_TOKEN) {
            const auth = req.headers.get("authorization");
            if (auth !== `Bearer ${env.STATUS_TOKEN}`) {
              return json({ ok: false, error: "unauthorized" }, 401);
            }
          }
          const ready = client.isReady();
          const readyState = mongoose.connection.readyState;
          return json({
            ok: true,
            service: config.name,
            version: config.version,
            uptimeSec: uptimeSec(),
            db: {
              connected: readyState === 1,
              state: DB_STATES[readyState] ?? `unknown(${readyState})`,
            },
            bot: {
              ready,
              user: client.user?.tag ?? null,
              guilds: client.guilds.cache.size,
              wsPing: ready ? client.ws.ping : null,
            },
            memoryMB: Math.round(process.memoryUsage().rss / 1048576),
          });
        }

        return json({ ok: false, error: "not found" }, 404);
      },
      error(err) {
        console.error("[health] request error:", err);
        return json({ ok: false, error: "internal error" }, 500);
      },
    });
    console.log(`[health] listening on http://0.0.0.0:${env.PORT} — routes: / /health /status`);
  } catch (err) {
    // Never let a busy port kill the bot: log it and keep going.
    console.warn(
      `[health] could not bind port ${env.PORT}:`,
      err instanceof Error ? err.message : err,
    );
  }
}
