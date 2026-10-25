import type { Env } from '../config/env.js';
import { EventBus } from './bus.js';
import { MemoryTransport } from './memory.js';
import { RedisStreamsTransport } from './redis.js';
import { RespConnection } from './resp.js';
import type { EventBusLogger } from './types.js';

export { EventBus, type EventBusOptions, type ListenOptions, type SubscribeOptions } from './bus.js';
export { MemoryTransport } from './memory.js';
export { RedisStreamsTransport, type RedisTransportOptions } from './redis.js';
export {
  encodeCommand,
  parseReply,
  RedisReplyError,
  RespConnection,
  type RedisCommander,
  type RedisConnectOptions,
  type RespValue,
} from './resp.js';
export type { EngineEvent, EventBusLogger, EventHandler, EventTransport } from './types.js';

/** Build the bus `EVENT_BUS_DRIVER` asks for. */
export function createEventBus(env: Env, logger?: EventBusLogger): EventBus {
  if (env.EVENT_BUS_DRIVER === 'redis') {
    const url = env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL is required when EVENT_BUS_DRIVER=redis');
    return new EventBus({
      transport: new RedisStreamsTransport({
        connect: () => RespConnection.connect({ url }),
        stream: env.EVENT_BUS_STREAM,
        group: env.EVENT_BUS_GROUP,
        maxLength: env.EVENT_BUS_MAX_LENGTH,
        ...(logger ? { logger } : {}),
      }),
      ...(logger ? { logger } : {}),
    });
  }
  return new EventBus({ transport: new MemoryTransport(), ...(logger ? { logger } : {}) });
}
