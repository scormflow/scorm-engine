import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { encodeCommand, parseReply, RedisReplyError, RespConnection } from '../../src/events/resp.js';

describe('RESP codec', () => {
  it('encodes commands as arrays of bulk strings, counting bytes not characters', () => {
    expect(encodeCommand(['SET', 'k', 1]).toString()).toBe('*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$1\r\n1\r\n');
    expect(encodeCommand(['é']).toString()).toBe('*1\r\n$2\r\né\r\n');
  });

  it('parses every reply type', () => {
    const parse = (s: string) => parseReply(Buffer.from(s));
    expect(parse('+OK\r\n')).toEqual({ value: 'OK', end: 5 });
    expect(parse(':42\r\n')).toMatchObject({ value: 42 });
    expect(parse('$5\r\nhello\r\n')).toMatchObject({ value: 'hello' });
    expect(parse('$-1\r\n')).toMatchObject({ value: null });
    expect(parse('*-1\r\n')).toMatchObject({ value: null });
    expect(parse('*2\r\n$1\r\na\r\n*1\r\n:1\r\n')).toMatchObject({ value: ['a', [1]] });
    const err = parse('-BUSYGROUP exists\r\n');
    expect(err).not.toBeTypeOf('symbol');
    expect((err as { value: unknown }).value).toBeInstanceOf(RedisReplyError);
  });

  it('reports a reply cut off mid-way as incomplete', () => {
    for (const partial of ['+OK', '$5\r\nhel', '*2\r\n$1\r\na\r\n', '*1\r\n$3\r\nab']) {
      expect(typeof parseReply(Buffer.from(partial))).toBe('symbol');
    }
  });

  it('rejects an unknown type byte', () => {
    expect(() => parseReply(Buffer.from('?x\r\n'))).toThrow('Unexpected RESP type');
  });
});

describe('RespConnection', () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  /** A server that records commands and answers each with the next canned reply, split in two chunks. */
  async function listen(replies: string[]) {
    const received: string[] = [];
    server = net.createServer((socket) => {
      socket.on('data', (chunk) => {
        received.push(chunk.toString());
        const commands = chunk.toString().split(/(?=\*\d+\r\n\$)/);
        const reply = commands.map(() => replies.shift() ?? '+OK\r\n').join('');
        const mid = Math.floor(reply.length / 2);
        socket.write(reply.slice(0, mid));
        setTimeout(() => socket.write(reply.slice(mid)), 2);
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server!.address() as net.AddressInfo;
    return { port, received };
  }

  it('authenticates, selects the database, and answers commands in order', async () => {
    const { port, received } = await listen(['+OK\r\n', '+OK\r\n', '$3\r\nbar\r\n', ':7\r\n']);
    const conn = await RespConnection.connect({ url: `redis://user:p%40ss@127.0.0.1:${port}/2` });
    const [a, b] = await Promise.all([conn.send(['GET', 'foo']), conn.send(['INCR', 'n'])]);
    expect(a).toBe('bar');
    expect(b).toBe(7);
    const all = received.join('');
    expect(all).toContain('$4\r\nAUTH\r\n$4\r\nuser\r\n$4\r\np@ss\r\n');
    expect(all).toContain('$6\r\nSELECT\r\n$1\r\n2\r\n');
    await conn.close();
    await expect(conn.send(['PING'])).rejects.toThrow('closed');
  });

  it('rejects a command answered with an error reply and keeps going', async () => {
    const { port } = await listen(['-ERR wrong type\r\n', '+PONG\r\n']);
    const conn = await RespConnection.connect({ url: `redis://127.0.0.1:${port}` });
    await expect(conn.send(['GET', 'x'])).rejects.toBeInstanceOf(RedisReplyError);
    await expect(conn.send(['PING'])).resolves.toBe('PONG');
    await conn.close();
  });

  it('fails pending commands when the server hangs up', async () => {
    server = net.createServer((socket) => socket.on('data', () => socket.destroy()));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as net.AddressInfo;
    const conn = await RespConnection.connect({ url: `redis://127.0.0.1:${port}` });
    await expect(conn.send(['PING'])).rejects.toThrow('closed');
  });

  it('refuses non-Redis URLs', async () => {
    await expect(RespConnection.connect({ url: 'http://localhost:6379' })).rejects.toThrow('Unsupported');
  });
});
