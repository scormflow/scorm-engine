import net from 'node:net';
import tls from 'node:tls';

/**
 * A minimal Redis client: RESP2 over one TCP (or TLS) connection, commands
 * pipelined in order. It knows just enough to run the stream commands the
 * Redis event transport needs, which keeps the engine free of a Redis
 * dependency — in the same spirit as the hand-rolled SigV4 S3 driver.
 *
 * A blocking command (`XREADGROUP … BLOCK`) holds its connection until it
 * returns, so callers that block open a connection of their own.
 */

/** A reply. Error replies nested inside an array stay in place as {@link RedisReplyError}s. */
export type RespValue = string | number | null | RedisReplyError | RespValue[];

export class RedisReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisReplyError';
  }
}

/** What the transport needs from a connection. Tests substitute a fake. */
export interface RedisCommander {
  send(args: ReadonlyArray<string | number>): Promise<RespValue>;
  close(): Promise<void>;
}

export interface RedisConnectOptions {
  /** `redis://[user:pass@]host[:port][/db]` or `rediss://…` for TLS. */
  url: string;
  connectTimeoutMs?: number;
}

/** Encode one command as a RESP array of bulk strings. */
export function encodeCommand(args: ReadonlyArray<string | number>): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const value = Buffer.from(String(arg), 'utf8');
    parts.push(Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

const INCOMPLETE = Symbol('incomplete');
type Parsed = { value: RespValue; end: number };

/** Parse one reply starting at `offset`. Returns `INCOMPLETE` when the buffer ends mid-reply. */
export function parseReply(buf: Buffer, offset = 0): Parsed | typeof INCOMPLETE {
  const lineEnd = buf.indexOf('\r\n', offset);
  if (lineEnd === -1) return INCOMPLETE;
  const kind = String.fromCharCode(buf[offset]!);
  const line = buf.toString('utf8', offset + 1, lineEnd);
  const next = lineEnd + 2;
  switch (kind) {
    case '+':
      return { value: line, end: next };
    case '-':
      return { value: new RedisReplyError(line), end: next };
    case ':':
      return { value: Number(line), end: next };
    case '$': {
      const len = Number(line);
      if (len < 0) return { value: null, end: next };
      if (buf.length < next + len + 2) return INCOMPLETE;
      return { value: buf.toString('utf8', next, next + len), end: next + len + 2 };
    }
    case '*': {
      const count = Number(line);
      if (count < 0) return { value: null, end: next };
      const items: RespValue[] = [];
      let at = next;
      for (let i = 0; i < count; i++) {
        const item = parseReply(buf, at);
        if (item === INCOMPLETE) return INCOMPLETE;
        items.push(item.value);
        at = item.end;
      }
      return { value: items, end: at };
    }
    default:
      throw new Error(`Unexpected RESP type byte ${JSON.stringify(kind)}`);
  }
}

interface Waiter {
  resolve(value: RespValue): void;
  reject(err: Error): void;
}

export class RespConnection implements RedisCommander {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly waiters: Waiter[] = [];
  private closedError: Error | undefined;

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('error', (err) => this.fail(err));
    socket.on('close', () => this.fail(new Error('Redis connection closed')));
  }

  /** Connect, authenticate and select the database named in the URL. */
  static async connect(options: RedisConnectOptions): Promise<RespConnection> {
    const url = new URL(options.url);
    if (url.protocol !== 'redis:' && url.protocol !== 'rediss:') {
      throw new Error(`Unsupported Redis URL scheme ${url.protocol}`);
    }
    const host = url.hostname || '127.0.0.1';
    const port = Number(url.port || 6379);
    const timeout = options.connectTimeoutMs ?? 10_000;

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s =
        url.protocol === 'rediss:'
          ? tls.connect({ host, port, servername: host }, () => resolve(s))
          : net.connect({ host, port }, () => resolve(s));
      s.setTimeout(timeout, () => s.destroy(new Error(`Redis connect timed out after ${timeout} ms`)));
      s.once('error', reject);
    });
    socket.setTimeout(0);
    socket.setNoDelay(true);
    const conn = new RespConnection(socket);

    try {
      const user = decodeURIComponent(url.username);
      const pass = decodeURIComponent(url.password);
      if (pass) await conn.send(user ? ['AUTH', user, pass] : ['AUTH', pass]);
      const db = url.pathname.replace(/^\//, '');
      if (db && db !== '0') await conn.send(['SELECT', db]);
    } catch (err) {
      await conn.close();
      throw err;
    }
    return conn;
  }

  send(args: ReadonlyArray<string | number>): Promise<RespValue> {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise<RespValue>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.socket.write(encodeCommand(args));
    });
  }

  async close(): Promise<void> {
    if (this.closedError) return;
    this.fail(new Error('Redis connection closed'));
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    let offset = 0;
    while (offset < this.buffer.length) {
      let parsed: ReturnType<typeof parseReply>;
      try {
        parsed = parseReply(this.buffer, offset);
      } catch (err) {
        this.socket.destroy(err as Error);
        return;
      }
      if (parsed === INCOMPLETE) break;
      offset = parsed.end;
      const waiter = this.waiters.shift();
      if (!waiter) continue;
      if (parsed.value instanceof RedisReplyError) waiter.reject(parsed.value);
      else waiter.resolve(parsed.value);
    }
    this.buffer = offset >= this.buffer.length ? Buffer.alloc(0) : this.buffer.subarray(offset);
  }

  private fail(err: Error): void {
    if (this.closedError) return;
    this.closedError = err;
    for (const waiter of this.waiters.splice(0)) waiter.reject(err);
  }
}
