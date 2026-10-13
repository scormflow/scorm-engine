import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';

import { isWebhookEventType } from '../webhooks/events.js';
import { RedisReplyError, type RedisCommander, type RespValue } from './resp.js';
import type { EngineEvent, EventBusLogger, EventTransport } from './types.js';

/**
 * Event transport over a Redis stream.
 *
 * Every event is one `XADD` entry. Two loops read the stream, each on its own
 * connection because both block:
 *
 *  - the **work loop** reads through a consumer group (`XREADGROUP`), so each
 *    entry goes to one engine instance in the group. An entry is `XACK`ed once
 *    its handlers succeed. Entries left unacknowledged — a handler failed, or
 *    the instance died mid-flight — are claimed again after `claimIdleMs`
 *    and retried, up to `maxDeliveries`; then they are copied to
 *    `<stream>:dead` and acknowledged so they stop blocking the group.
 *  - the **broadcast loop** reads the stream directly (`XREAD`) from the
 *    moment the instance started, so every instance sees every entry.
 *
 * The stream is capped with `MAXLEN ~ maxLength`. Requires Redis 6.2+.
 */

export interface RedisTransportOptions {
  /** Opens a fresh connection. The transport opens three: commands, work, broadcast. */
  connect: () => Promise<RedisCommander>;
  stream?: string;
  group?: string;
  /** Unique per instance. Defaults to `<hostname>-<pid>-<random>`. */
  consumer?: string;
  /** Approximate cap on the stream's length. */
  maxLength?: number;
  /** How long one blocking read waits before looping. */
  blockMs?: number;
  /** Entries read per call. */
  batchSize?: number;
  /** How long an entry may sit unacknowledged before another delivery is attempted. */
  claimIdleMs?: number;
  /** Deliveries an entry gets before it is dead-lettered. */
  maxDeliveries?: number;
  /** Wait between reconnect attempts after a connection fails. */
  reconnectDelayMs?: number;
  logger?: EventBusLogger;
}

const DEFAULTS = {
  stream: 'scormflow:events',
  group: 'scormflow',
  maxLength: 100_000,
  blockMs: 5_000,
  batchSize: 50,
  claimIdleMs: 60_000,
  maxDeliveries: 5,
  reconnectDelayMs: 1_000,
};

/** One entry as Redis returns it: `[id, [field, value, …]]`. */
type StreamEntry = [string, string[]];

export class RedisStreamsTransport implements EventTransport {
  readonly name = 'redis';
  readonly stream: string;
  readonly group: string;
  readonly consumer: string;
  private readonly opts: typeof DEFAULTS;
  private onConsume: ((event: EngineEvent) => Promise<void>) | undefined;
  private onBroadcast: ((event: EngineEvent) => void) | undefined;
  private commands: Promise<RedisCommander> | undefined;
  private readonly loopConnections = new Set<RedisCommander>();
  private readonly loops: Promise<void>[] = [];
  private stopped = false;

  constructor(private readonly options: RedisTransportOptions) {
    this.opts = {
      stream: options.stream ?? DEFAULTS.stream,
      group: options.group ?? DEFAULTS.group,
      maxLength: options.maxLength ?? DEFAULTS.maxLength,
      blockMs: options.blockMs ?? DEFAULTS.blockMs,
      batchSize: options.batchSize ?? DEFAULTS.batchSize,
      claimIdleMs: options.claimIdleMs ?? DEFAULTS.claimIdleMs,
      maxDeliveries: options.maxDeliveries ?? DEFAULTS.maxDeliveries,
      reconnectDelayMs: options.reconnectDelayMs ?? DEFAULTS.reconnectDelayMs,
    };
    this.stream = this.opts.stream;
    this.group = this.opts.group;
    this.consumer = options.consumer ?? `${hostname()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  }

  async publish(event: EngineEvent): Promise<void> {
    const conn = await this.commandConnection();
    await conn.send([
      'XADD',
      this.stream,
      'MAXLEN',
      '~',
      this.opts.maxLength,
      '*',
      'event',
      JSON.stringify(event),
    ]);
  }

  consume(handler: (event: EngineEvent) => Promise<void>): void {
    this.onConsume = handler;
  }

  broadcast(handler: (event: EngineEvent) => void): void {
    this.onBroadcast = handler;
  }

  async start(): Promise<void> {
    const conn = await this.commandConnection();
    await this.ensureGroup(conn);
    // Read the broadcast loop's starting point now, so nothing published after
    // `start` resolves can slip past it.
    const lastId = await this.lastEntryId(conn);
    if (this.onConsume) this.loops.push(this.runLoop('work', (c) => this.workOnce(c)));
    if (this.onBroadcast) {
      let cursor = lastId;
      this.loops.push(
        this.runLoop('broadcast', async (c) => {
          cursor = await this.broadcastOnce(c, cursor);
        }),
      );
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    // Closing a connection mid-`BLOCK` rejects its read, which ends the loop.
    await Promise.all([...this.loopConnections].map((c) => c.close().catch(() => undefined)));
    await Promise.allSettled(this.loops);
    const commands = this.commands;
    this.commands = undefined;
    if (commands) await (await commands.catch(() => undefined))?.close().catch(() => undefined);
  }

  /**
   * One pass of the work loop: retry or dead-letter stale entries, then block
   * for new ones. Exposed for tests.
   */
  async workOnce(conn: RedisCommander): Promise<void> {
    await this.reclaimStale(conn);
    const reply = await conn.send([
      'XREADGROUP',
      'GROUP',
      this.group,
      this.consumer,
      'COUNT',
      this.opts.batchSize,
      'BLOCK',
      this.opts.blockMs,
      'STREAMS',
      this.stream,
      '>',
    ]);
    await this.handleEntries(conn, entriesOf(reply));
  }

  /** One pass of the broadcast loop; returns the new cursor. Exposed for tests. */
  async broadcastOnce(conn: RedisCommander, cursor: string): Promise<string> {
    const reply = await conn.send([
      'XREAD',
      'COUNT',
      this.opts.batchSize,
      'BLOCK',
      this.opts.blockMs,
      'STREAMS',
      this.stream,
      cursor,
    ]);
    let next = cursor;
    for (const [id, fields] of entriesOf(reply)) {
      next = id;
      const event = decodeEvent(fields);
      if (event) this.onBroadcast?.(event);
    }
    return next;
  }

  // ---- internals -----------------------------------------------------------

  private commandConnection(): Promise<RedisCommander> {
    if (!this.commands) {
      this.commands = this.options.connect();
      // A failed connect must not poison every later publish.
      this.commands.catch(() => {
        this.commands = undefined;
      });
    }
    return this.commands;
  }

  private async ensureGroup(conn: RedisCommander): Promise<void> {
    try {
      await conn.send(['XGROUP', 'CREATE', this.stream, this.group, '$', 'MKSTREAM']);
    } catch (err) {
      if (!(err instanceof RedisReplyError && err.message.startsWith('BUSYGROUP'))) throw err;
    }
  }

  private async lastEntryId(conn: RedisCommander): Promise<string> {
    const reply = await conn.send(['XREVRANGE', this.stream, '+', '-', 'COUNT', 1]);
    const first = Array.isArray(reply) ? reply[0] : undefined;
    return Array.isArray(first) && typeof first[0] === 'string' ? first[0] : '0-0';
  }

  /** Run `step` until stopped, on a dedicated connection that is reopened after errors. */
  private async runLoop(name: string, step: (conn: RedisCommander) => Promise<void>): Promise<void> {
    let conn: RedisCommander | undefined;
    while (!this.stopped) {
      try {
        if (!conn) {
          conn = await this.options.connect();
          this.loopConnections.add(conn);
          if (this.stopped) break;
          if (name === 'work') await this.ensureGroup(conn);
        }
        await step(conn);
      } catch (err) {
        if (this.stopped) break;
        this.options.logger?.error({ err, loop: name, stream: this.stream }, 'event bus read failed');
        if (conn) {
          this.loopConnections.delete(conn);
          await conn.close().catch(() => undefined);
          conn = undefined;
        }
        await delay(this.opts.reconnectDelayMs);
      }
    }
    if (conn) {
      this.loopConnections.delete(conn);
      await conn.close().catch(() => undefined);
    }
  }

  private async handleEntries(conn: RedisCommander, entries: StreamEntry[]): Promise<void> {
    for (const [id, fields] of entries) {
      const event = decodeEvent(fields);
      if (!event) {
        this.options.logger?.warn({ id, stream: this.stream }, 'event bus skipped an unreadable entry');
        await conn.send(['XACK', this.stream, this.group, id]);
        continue;
      }
      try {
        await this.onConsume?.(event);
      } catch {
        // Left pending: `reclaimStale` retries it once it has been idle long enough.
        continue;
      }
      await conn.send(['XACK', this.stream, this.group, id]);
    }
  }

  /**
   * Retry entries that have been pending longer than `claimIdleMs` — failed
   * here, or orphaned by a consumer that went away — and dead-letter those
   * that have used up their deliveries.
   */
  private async reclaimStale(conn: RedisCommander): Promise<void> {
    const pending = await conn.send([
      'XPENDING',
      this.stream,
      this.group,
      'IDLE',
      this.opts.claimIdleMs,
      '-',
      '+',
      this.opts.batchSize,
    ]);
    if (!Array.isArray(pending) || pending.length === 0) return;

    const retry: string[] = [];
    for (const row of pending) {
      if (!Array.isArray(row)) continue;
      const [id, , , deliveries] = row;
      if (typeof id !== 'string') continue;
      if (Number(deliveries) >= this.opts.maxDeliveries) await this.deadLetter(conn, id, Number(deliveries));
      else retry.push(id);
    }
    if (retry.length === 0) return;

    const claimed = await conn.send([
      'XCLAIM',
      this.stream,
      this.group,
      this.consumer,
      this.opts.claimIdleMs,
      ...retry,
    ]);
    await this.handleEntries(conn, toEntries(claimed));
  }

  private async deadLetter(conn: RedisCommander, id: string, deliveries: number): Promise<void> {
    const range = await conn.send(['XRANGE', this.stream, id, id]);
    const [entry] = toEntries(range);
    if (entry) {
      await conn.send([
        'XADD',
        `${this.stream}:dead`,
        'MAXLEN',
        '~',
        this.opts.maxLength,
        '*',
        ...entry[1],
        'sourceId',
        id,
        'deliveries',
        deliveries,
      ]);
    }
    await conn.send(['XACK', this.stream, this.group, id]);
    this.options.logger?.error({ id, deliveries, stream: this.stream }, 'event dead-lettered after repeated failures');
  }
}

/** Entries from an `XREAD`/`XREADGROUP` reply: `[[stream, entries]]`, or null on timeout. */
function entriesOf(reply: RespValue): StreamEntry[] {
  if (!Array.isArray(reply)) return [];
  const out: StreamEntry[] = [];
  for (const streamReply of reply) {
    if (Array.isArray(streamReply)) out.push(...toEntries(streamReply[1] ?? null));
  }
  return out;
}

/** Entries from a list reply (`XRANGE`, `XCLAIM`); deleted entries come back as `[id, null]` and are dropped. */
function toEntries(reply: RespValue): StreamEntry[] {
  if (!Array.isArray(reply)) return [];
  const out: StreamEntry[] = [];
  for (const item of reply) {
    if (!Array.isArray(item)) continue;
    const [id, fields] = item;
    if (typeof id !== 'string' || !Array.isArray(fields)) continue;
    out.push([id, fields.filter((f): f is string => typeof f === 'string')]);
  }
  return out;
}

function decodeEvent(fields: string[]): EngineEvent | null {
  const at = fields.indexOf('event');
  const raw = at >= 0 && at % 2 === 0 ? fields[at + 1] : undefined;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<EngineEvent>;
    if (
      typeof parsed.id !== 'string' ||
      typeof parsed.tenantId !== 'string' ||
      typeof parsed.type !== 'string' ||
      !isWebhookEventType(parsed.type) ||
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.data !== 'object' ||
      parsed.data === null
    ) {
      return null;
    }
    return parsed as EngineEvent;
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}
