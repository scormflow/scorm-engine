import { RedisReplyError, type RedisCommander, type RespValue } from '../../src/events/resp.js';

/**
 * Just enough of Redis streams, in memory, for the event transport: XADD,
 * XGROUP CREATE, XREAD/XREADGROUP (with BLOCK), XACK, XPENDING (IDLE form),
 * XCLAIM, XRANGE and XREVRANGE. Entry ids are `<n>-0`. `advance` moves the
 * clock that pending-entry idle times are measured against.
 */

interface Entry {
  id: string;
  fields: string[];
}

interface PendingEntry {
  consumer: string;
  deliveries: number;
  deliveredAt: number;
}

interface Group {
  lastDelivered: number;
  pending: Map<string, PendingEntry>;
}

interface StreamState {
  entries: Entry[];
  groups: Map<string, Group>;
}

export class FakeRedis {
  readonly streams = new Map<string, StreamState>();
  readonly log: string[][] = [];
  private seq = 0;
  private clock = 0;
  private wakers = new Set<() => void>();
  connections = 0;

  advance(ms: number): void {
    this.clock += ms;
  }

  entries(key: string): Entry[] {
    return this.streams.get(key)?.entries ?? [];
  }

  pending(key: string, group: string): Map<string, PendingEntry> {
    return this.streams.get(key)?.groups.get(group)?.pending ?? new Map();
  }

  connect = async (): Promise<RedisCommander> => {
    this.connections++;
    let closed = false;
    const cancel = new Set<(err: Error) => void>();
    return {
      send: async (args) => {
        if (closed) throw new Error('Redis connection closed');
        const parts = args.map(String);
        this.log.push(parts);
        return this.run(parts, () => closed, cancel);
      },
      close: async () => {
        closed = true;
        for (const c of cancel) c(new Error('Redis connection closed'));
      },
    };
  };

  private stream(key: string, create: boolean): StreamState | undefined {
    let s = this.streams.get(key);
    if (!s && create) {
      s = { entries: [], groups: new Map() };
      this.streams.set(key, s);
    }
    return s;
  }

  private async run(
    args: string[],
    isClosed: () => boolean,
    cancel: Set<(err: Error) => void>,
  ): Promise<RespValue> {
    const [cmd, ...rest] = args;
    switch (cmd!.toUpperCase()) {
      case 'XADD': {
        const key = rest[0]!;
        let i = 1;
        if (rest[i] === 'MAXLEN') i += rest[i + 1] === '~' ? 3 : 2;
        i += 1; // '*'
        const id = `${++this.seq}-0`;
        this.stream(key, true)!.entries.push({ id, fields: rest.slice(i) });
        for (const wake of [...this.wakers]) wake();
        return id;
      }
      case 'XGROUP': {
        const [, key, group, , mk] = rest;
        const s = this.stream(key!, mk === 'MKSTREAM');
        if (!s) throw new RedisReplyError('ERR no such key');
        if (s.groups.has(group!)) throw new RedisReplyError('BUSYGROUP Consumer Group name already exists');
        s.groups.set(group!, { lastDelivered: this.seq, pending: new Map() });
        return 'OK';
      }
      case 'XREVRANGE': {
        const last = this.entries(rest[0]!).at(-1);
        return last ? [[last.id, last.fields]] : [];
      }
      case 'XRANGE': {
        const [key, from] = rest;
        return this.entries(key!)
          .filter((e) => e.id === from)
          .map((e) => [e.id, e.fields]);
      }
      case 'XREAD':
      case 'XREADGROUP': {
        const group = cmd === 'XREADGROUP' ? rest[1]! : undefined;
        const consumer = cmd === 'XREADGROUP' ? rest[2]! : undefined;
        const count = Number(rest[rest.indexOf('COUNT') + 1]);
        const block = Number(rest[rest.indexOf('BLOCK') + 1]);
        const key = rest[rest.indexOf('STREAMS') + 1]!;
        const cursor = rest[rest.indexOf('STREAMS') + 2]!;
        const read = (): RespValue => {
          const s = this.stream(key, false);
          if (!s) return null;
          if (group) {
            const g = s.groups.get(group);
            if (!g) throw new RedisReplyError('NOGROUP No such consumer group');
            const fresh = s.entries.filter((e) => num(e.id) > g.lastDelivered).slice(0, count);
            if (fresh.length === 0) return null;
            for (const e of fresh) {
              g.lastDelivered = num(e.id);
              g.pending.set(e.id, { consumer: consumer!, deliveries: 1, deliveredAt: this.clock });
            }
            return [[key, fresh.map((e) => [e.id, e.fields])]];
          }
          const fresh = s.entries.filter((e) => num(e.id) > num(cursor)).slice(0, count);
          return fresh.length ? [[key, fresh.map((e) => [e.id, e.fields])]] : null;
        };
        const first = read();
        if (first !== null || block <= 0) return first;
        return new Promise<RespValue>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            this.wakers.delete(wake);
            cancel.delete(onCancel);
          };
          const wake = () => {
            if (isClosed()) return;
            try {
              const r = read();
              if (r !== null) {
                done();
                resolve(r);
              }
            } catch (err) {
              done();
              reject(err);
            }
          };
          const onCancel = (err: Error) => {
            done();
            reject(err);
          };
          const timer = setTimeout(() => {
            done();
            resolve(null);
          }, block);
          this.wakers.add(wake);
          cancel.add(onCancel);
        });
      }
      case 'XACK': {
        const [key, group, ...ids] = rest;
        const g = this.streams.get(key!)?.groups.get(group!);
        let n = 0;
        for (const id of ids) if (g?.pending.delete(id)) n++;
        return n;
      }
      case 'XPENDING': {
        const [key, group, , idle, , , count] = rest;
        const g = this.streams.get(key!)?.groups.get(group!);
        if (!g) return [];
        return [...g.pending.entries()]
          .filter(([, p]) => this.clock - p.deliveredAt >= Number(idle))
          .slice(0, Number(count))
          .map(([id, p]) => [id, p.consumer, this.clock - p.deliveredAt, p.deliveries]);
      }
      case 'XCLAIM': {
        const [key, group, consumer, minIdle, ...ids] = rest;
        const s = this.streams.get(key!)!;
        const g = s.groups.get(group!)!;
        const out: RespValue[] = [];
        for (const id of ids) {
          const p = g.pending.get(id);
          if (!p || this.clock - p.deliveredAt < Number(minIdle)) continue;
          p.consumer = consumer!;
          p.deliveries++;
          p.deliveredAt = this.clock;
          const e = s.entries.find((x) => x.id === id);
          if (e) out.push([e.id, e.fields]);
        }
        return out;
      }
      default:
        throw new RedisReplyError(`ERR unknown command '${cmd}'`);
    }
  }
}

function num(id: string): number {
  return Number(id.split('-')[0]);
}
