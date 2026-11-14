import http from "node:http";
import { env } from "../env";
import { client, startupAt } from "./client";

/**
 * Tiny HTTP server so Render (or any host/health monitor) has an open port.
 * Render binds your service to process.env.PORT and polls it — without a
 * listener the deploy fails with "no open port".
 *
 *   GET /        → 200 { status: "ok" }        (Render health check)
 *   GET /health  → 200 { status: "ok" }
 *   GET /status  → 200 bot info (add ?token= or Authorization: Bearer <STATUS_TOKEN>
 *                  when STATUS_TOKEN is set)
 */
export function startHealthServer(): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    const json = (code: number, body: unknown): void => {
      const data = JSON.stringify(body);
      res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(data),
      });
      res.end(data);
    };

    if (req.method !== "GET") {
      json(405, { error: "method not allowed" });
      return;
    }

    if (path === "/" || path === "/health") {
      json(200, { status: "ok", service: "novax-guard" });
      return;
    }

    if (path === "/status") {
      if (env.STATUS_TOKEN) {
        const auth = req.headers.authorization ?? "";
        const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const query = url.searchParams.get("token") ?? "";
        if (bearer !== env.STATUS_TOKEN && query !== env.STATUS_TOKEN) {
          json(401, { error: "unauthorized" });
          return;
        }
      }
      json(200, {
        status: client.isReady() ? "online" : "starting",
        uptimeMs: Date.now() - startupAt,
        ping: client.ws?.ping ?? null,
        guilds: client.guilds.cache.size,
      });
      return;
    }

    json(404, { error: "not found" });
  });

  server.listen(env.PORT, "0.0.0.0", () => {
    console.log(`[health] listening on http://0.0.0.0:${env.PORT} — / /health /status`);
  });
  server.on("error", (err) => {
    console.error(`[health] could not bind port ${env.PORT}:`, err.message);
  });

  return server;
}
