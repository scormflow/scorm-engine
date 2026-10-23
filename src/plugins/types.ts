import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import type { Env } from '../config/env.js';
import type { PrismaClient } from '../db/client.js';
import type { EventBus, EventHandler, ListenOptions, SubscribeOptions } from '../events/index.js';
import type { StorageAdapter } from '../storage/types.js';

/**
 * A plugin extends the engine from the outside: it reacts to engine events and
 * may add API routes, using only what its {@link PluginContext} hands it.
 *
 * ```ts
 * const app = await buildApp({ env, plugins: [analyticsPlugin(), myPlugin()] });
 * ```
 *
 * Plugins are set up in order, once, while the app is built; a plugin that
 * throws from `setup` fails `buildApp`.
 */
export interface ScormflowPlugin {
  /**
   * Unique, URL-safe name (`[a-z][a-z0-9-]*`, up to 63 characters). It names
   * the plugin's route prefix (`/api/v1/plugins/<name>`), its subscribers and
   * its log lines.
   */
  name: string;
  /** Reported by `GET /api/v1/plugins`. */
  version?: string;
  setup(ctx: PluginContext): void | Promise<void>;
}

/** Registers a plugin's routes on a Fastify scope mounted at `/api/v1/plugins/<name>`. */
export type PluginRoutes = (scope: FastifyInstance) => void | Promise<void>;

export interface PluginContext {
  readonly name: string;
  readonly env: Env;
  readonly prisma: PrismaClient;
  readonly storage: StorageAdapter;
  /** The engine's event bus, for publishing; prefer `subscribe` / `listen` below for receiving. */
  readonly events: EventBus;
  /** The app logger, tagged with `{ plugin: name }`. */
  readonly log: FastifyBaseLogger;
  /**
   * Do work on matching events. Like `events.subscribe`, the handler runs on
   * **one** instance per event when the bus is shared, and a rejection asks
   * for redelivery — so make it idempotent on `event.id`. `key` tells a
   * plugin's subscribers apart; the bus sees `plugin:<name>:<key>`.
   */
  subscribe(key: string, handler: EventHandler, options?: SubscribeOptions): () => void;
  /** Observe matching events on **every** instance (counters, caches, streams). */
  listen(handler: EventHandler, options?: ListenOptions): () => void;
  /**
   * Add routes under `/api/v1/plugins/<name>`. Every route requires an API key
   * (`req.tenantId` is set by the time a handler runs) and counts toward the
   * tenant's rate limit. Call during `setup`; may be called more than once.
   */
  routes(register: PluginRoutes): void;
  /** Run when the app closes, after the event bus has drained. Closers run in reverse install order. */
  onClose(fn: () => void | Promise<void>): void;
}

/** Identity helper that types a plugin object literal. */
export function definePlugin(plugin: ScormflowPlugin): ScormflowPlugin {
  return plugin;
}
