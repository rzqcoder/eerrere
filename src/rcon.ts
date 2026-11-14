import { Socket } from "node:net";

/* Source RCON protocol (used by vanilla/Spigot servers). */
const SERVERDATA_RESPONSE_VALUE = 0;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_AUTH = 3;
const SERVERDATA_AUTH_RESPONSE = 2;

interface RconPacket {
  id: number;
  type: number;
  body: string;
}

/** [size:i32][id:i32][type:i32][body][\0\0] — size counts everything after itself. */
function encodePacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, "utf8");
  const size = 4 + 4 + bodyBuf.length + 2;
  const buf = Buffer.alloc(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  return buf;
}

/** Pull every complete packet off the front of `buffer`; return them plus the remainder. */
function decodePackets(buffer: Buffer): { packets: RconPacket[]; rest: Buffer } {
  const packets: RconPacket[] = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const size = buffer.readInt32LE(offset);
    if (size < 10) break; // malformed — stop rather than desync
    if (buffer.length - offset < 4 + size) break; // incomplete — wait for more bytes
    packets.push({
      id: buffer.readInt32LE(offset + 4),
      type: buffer.readInt32LE(offset + 8),
      body: buffer.subarray(offset + 12, offset + 4 + size - 2).toString("utf8"),
    });
    offset += 4 + size;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/**
 * Execute one console command over Source RCON.
 * Fresh connection per call (commands are human-triggered, so cost is irrelevant).
 * Resolves with the server's text output — "" when the command gives no feedback.
 * Rejects with a human-readable message on config/auth/network problems.
 */
export function rconExec(command: string, timeoutMs = 8000): Promise<string> {
  // Read process.env per call (dotenv has already loaded .env into it at startup).
  const host = process.env.MC_RCON_HOST ?? "";
  const port = parseInt(process.env.MC_RCON_PORT ?? "25575", 10) || 25575;
  const password = process.env.MC_RCON_PASSWORD ?? "";
  if (!host || !password) {
    return Promise.reject(
      new Error("Minecraft RCON is not configured — set MC_RCON_HOST and MC_RCON_PASSWORD in .env."),
    );
  }

  return new Promise<string>((resolve, reject) => {
    const socket = new Socket();
    let buffer: Buffer = Buffer.alloc(0);
    let authed = false;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const responses: string[] = [];

    const finish = (err: Error | null, value = ""): void => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(overall);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    const overall = setTimeout(
      () =>
        finish(
          new Error(
            authed
              ? "RCON: the server sent no reply in time."
              : "RCON: connection/auth timed out — wrong host/port, or the server is offline.",
          ),
        ),
      timeoutMs,
    );

    // Nothing came back after auth → assume the command ran silently (e.g. /say).
    const bumpIdle = (ms: number, then: () => void): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(then, ms);
    };

    socket.on("error", (err) => finish(new Error(`RCON: ${err.message}`)));
    socket.on("close", () => {
      if (responses.length > 0) finish(null, responses.join("\n"));
      else finish(new Error("RCON: connection closed before the command finished."));
    });
    socket.on("connect", () => socket.write(encodePacket(1, SERVERDATA_AUTH, password)));

    socket.on("data", (chunk) => {
      const data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      buffer = Buffer.concat([buffer, data]);
      const { packets, rest } = decodePackets(buffer);
      buffer = rest;

      for (const pkt of packets) {
        if (!authed) {
          if (pkt.id === -1) {
            finish(new Error("RCON: authentication failed — check MC_RCON_PASSWORD."));
            return;
          }
          if (pkt.type === SERVERDATA_AUTH_RESPONSE) {
            authed = true;
            socket.write(encodePacket(2, SERVERDATA_EXECCOMMAND, command));
            bumpIdle(1200, () => finish(null, responses.join("\n")));
          }
          continue; // pre-auth RESPONSE_VALUE packets carry nothing useful
        }

        // Only our command's replies count (id 0 covers servers that don't echo).
        if (pkt.id !== 2 && pkt.id !== 0) continue;
        if (pkt.type !== SERVERDATA_RESPONSE_VALUE && pkt.type !== SERVERDATA_AUTH_RESPONSE) continue;
        if (pkt.body.length > 0) {
          responses.push(pkt.body);
          bumpIdle(300, () => finish(null, responses.join("\n")));
        } else {
          finish(null, responses.join("\n")); // empty packet = end of output
        }
      }
    });

    socket.connect(port, host);
  });
}
