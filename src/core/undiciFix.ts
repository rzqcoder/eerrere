import { createRequire } from "node:module";

/**
 * Bun ships a built-in `undici` compatibility module and its resolver prefers it
 * over the real `undici` package that soundcloud.ts (discord-player's SoundCloud
 * dependency) relies on. The stub's Pool is non-functional:
 *
 *   class Pool extends Dispatcher { request() {} }   // empty!
 *
 * so every Pool-based SoundCloud API call silently fails and playback dies with
 * "Could not extract stream for this track".
 *
 * This swaps the stub Pool for a small fetch-based implementation. It MUST be
 * imported before discord-player/soundcloud.ts loads — keep it as the first
 * import of src/index.ts.
 */

const require = createRequire(import.meta.url);
const undiciShim = require("undici") as Record<string, any>;

interface PoolRequestOptions {
  path?: string;
  method?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  body?: unknown;
  maxRedirections?: number;
}

/** Drop-in for undici's Pool.request(), returning the response shape soundcloud.ts expects. */
class FetchPool {
  static readonly novaxFixed = true;
  readonly origin: string;

  constructor(origin: string) {
    this.origin = origin;
  }

  async request(options: PoolRequestOptions = {}): Promise<{
    statusCode: number;
    headers: Record<string, string>;
    body: { json: () => Promise<unknown>; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> };
  }> {
    const path = options.path ?? "/";
    const url = new URL(
      path.startsWith("http") ? path : `${this.origin}${path.startsWith("/") ? path : `/${path}`}`,
    );
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }

    const method = (options.method ?? "GET").toUpperCase();
    const res = await fetch(url, {
      method,
      headers: options.headers,
      body:
        options.body !== undefined && method !== "GET" && method !== "HEAD"
          ? String(options.body)
          : undefined,
    });

    const text = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    if (!("content-type" in headers)) headers["content-type"] = "";

    return {
      statusCode: res.status,
      headers,
      body: {
        json: async () => JSON.parse(text) as unknown,
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      },
    };
  }
}

if (undiciShim.Pool && !undiciShim.Pool.novaxFixed) {
  undiciShim.Pool = FetchPool;
  console.log("[undiciFix] replaced Bun's stub undici.Pool with a fetch-based implementation");
}
