/**
 * A WebSocket pipe onto local Postgres, for the Neon driver.
 *
 * `@neondatabase/serverless` speaks WebSocket, and a throwaway Postgres speaks TCP. With
 * `neonConfig.wsProxy` set to `127.0.0.1:<port>/v2` the driver opens
 * `ws://127.0.0.1:<port>/v2?address=<host>:<port>` and sends the Postgres protocol as binary
 * frames. This accepts that upgrade and copies the bytes to 127.0.0.1. It is only started by
 * e2e/db-server.ts, and only against the database that file just created.
 */
import { createHash } from "node:crypto";
import { createServer, connect as connectTcp, type Server, type Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function startPgWsProxy(pgPort: number): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer((socket) => pipe(socket, pgPort));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("the local Postgres proxy did not bind"));
        return;
      }
      resolve({
        port: addr.port,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

function bytes(chunk: string | Buffer): Buffer {
  return typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
}

function pipe(socket: Socket, pgPort: number): void {
  let buf = Buffer.alloc(0);
  let upgraded = false;
  let pg: Socket | null = null;
  const pending: Buffer[] = [];

  const fail = () => {
    if (!socket.destroyed) socket.destroy();
    pg?.destroy();
  };

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, bytes(chunk)]);
    if (!upgraded) {
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = buf.subarray(0, end).toString("utf8");
      buf = buf.subarray(end + 4);
      const key = /Sec-WebSocket-Key:\s*(.+)/i.exec(head)?.[1]?.trim();
      if (!key) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      const accept = createHash("sha1").update(key + GUID).digest("base64");
      const protocol = /Sec-WebSocket-Protocol:\s*([^,\r]+)/i.exec(head)?.[1]?.trim();
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : "") +
          "\r\n",
      );
      upgraded = true;
      pg = connectTcp({ host: "127.0.0.1", port: pgPort });
      pg.on("connect", () => {
        for (const payload of pending.splice(0)) pg?.write(payload);
      });
      pg.on("data", (data) => {
        if (!socket.destroyed) socket.write(frame(bytes(data)));
      });
      pg.on("error", fail);
      pg.on("close", () => {
        if (!socket.destroyed) socket.end();
      });
    }
    drain();
  });
  socket.on("error", fail);
  socket.on("close", () => pg?.destroy());

  function drain(): void {
    for (;;) {
      const next = takeFrame(buf);
      if (!next) return;
      buf = Buffer.from(next.rest);
      if (next.opcode === 0x8) {
        socket.end(frame(next.payload, 0x8));
        pg?.end();
        return;
      }
      if (next.opcode === 0x9) {
        socket.write(frame(next.payload, 0xa));
        continue;
      }
      if (next.opcode === 0xa) continue;
      if (pg?.writable && !pg.connecting) pg.write(next.payload);
      else pending.push(next.payload);
    }
  }
}

function takeFrame(buf: Buffer): { opcode: number; payload: Buffer; rest: Buffer } | null {
  if (buf.length < 2) return null;
  const opcode = buf[0] & 0x0f;
  const masked = (buf[1] & 0x80) !== 0;
  let len = buf[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    const hi = buf.readUInt32BE(2);
    if (hi !== 0) return null;
    len = buf.readUInt32BE(6);
    off = 10;
  }
  const maskLen = masked ? 4 : 0;
  if (buf.length < off + maskLen + len) return null;
  const payload = Buffer.alloc(len);
  if (masked) {
    const mask = buf.subarray(off, off + 4);
    const data = buf.subarray(off + 4, off + 4 + len);
    for (let i = 0; i < len; i++) payload[i] = data[i]! ^ mask[i & 3]!;
  } else {
    buf.copy(payload, 0, off, off + len);
  }
  return { opcode, payload, rest: buf.subarray(off + maskLen + len) };
}

/** A server frame. Clients mask; servers do not. */
function frame(payload: Buffer, opcode = 0x2): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) head = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(len, 6);
  }
  return Buffer.concat([head, payload]);
}
