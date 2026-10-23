import type { FastifyInstance, FastifyPluginAsync, RouteOptions } from 'fastify';

import type { Env } from '../config/env.js';
import type { PrismaClient } from '../db/client.js';
import type { EventBus } from '../events/index.js';
import type { StorageAdapter } from '../storage/types.js';
import type { PluginContext, PluginRoutes, ScormflowPlugin } from './types.js';

/**
 * Installs plugins into an app being built: runs each `setup`, collects the
 * routes and closers it registers, and hands back what `buildApp` mounts.
 */

export interface PluginHostDeps {
  env: Env;
  prisma: PrismaClient;
  storage: StorageAdapter;
  events: EventBus;
}

export interface InstalledPlugin {
  name: string;
  version: string | null;
}

export interface PluginHost {
  installed: InstalledPlugin[];
  /** Mount under `/api/v1` with prefix `/plugins`. */
  routes: FastifyPluginAsync;
  /** Run every plugin's closers, newest plugin first. Never throws. */
  close(): Promise<void>;
}

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export class PluginError extends Error {
  constructor(
    public readonly plugin: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PluginError';
  }
}

export async function installPlugins(
  app: FastifyInstance,
  plugins: readonly ScormflowPlugin[],
  deps: PluginHostDeps,
): Promise<PluginHost> {
  const installed: InstalledPlugin[] = [];
  const routes = new Map<string, PluginRoutes[]>();
  const closers: Array<{ plugin: string; fn: () => void | Promise<void> }> = [];

  for (const plugin of plugins) {
    const name = plugin?.name;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      throw new PluginError(String(name), `Invalid plugin name ${JSON.stringify(name)}: use [a-z][a-z0-9-]*`);
    }
    if (installed.some((p) => p.name === name)) {
      throw new PluginError(name, `Plugin "${name}" is installed twice`);
    }
    if (typeof plugin.setup !== 'function') {
      throw new PluginError(name, `Plugin "${name}" has no setup function`);
    }

    const log = app.log.child({ plugin: name });
    const registrars: PluginRoutes[] = [];
    let settingUp = true;
    const ctx: PluginContext = {
      name,
      env: deps.env,
      prisma: deps.prisma,
      storage: deps.storage,
      events: deps.events,
      log,
      subscribe: (key, handler, options) => deps.events.subscribe(`plugin:${name}:${key}`, handler, options),
      listen: (handler, options) => deps.events.listen(handler, options),
      routes: (register) => {
        if (!settingUp) throw new PluginError(name, `Plugin "${name}" registered routes after setup`);
        registrars.push(register);
      },
      onClose: (fn) => {
        closers.push({ plugin: name, fn });
      },
    };

    try {
      await plugin.setup(ctx);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new PluginError(name, `Plugin "${name}" failed to set up: ${reason}`, { cause: err });
    } finally {
      settingUp = false;
    }

    installed.push({ name, version: plugin.version ?? null });
    if (registrars.length > 0) routes.set(name, registrars);
    log.debug('plugin installed');
  }

  return {
    installed,
    routes: async (scope) => {
      scope.get('/', { preHandler: scope.requireApiKey }, async () => ({ data: installed }));

      for (const [name, registrars] of routes) {
        await scope.register(
          async (pluginScope) => {
            pluginScope.addHook('onRoute', (route) => guardRoute(pluginScope, route));
            for (const register of registrars) await register(pluginScope);
          },
          { prefix: `/${name}` },
        );
      }
    },
    close: async () => {
      for (const { plugin, fn } of [...closers].reverse()) {
        try {
          await fn();
        } catch (err) {
          app.log.error({ err, plugin }, 'plugin close failed');
        }
      }
    },
  };
}

/**
 * Put the API-key guard in front of a plugin route's own preHandlers.
 *
 * The tenant rate limiter's `onRoute` hook (registered on the root, so it has
 * already run) appends its check only to routes that came with preHandlers;
 * a route that had none needs the check added here, after the guard.
 */
function guardRoute(scope: FastifyInstance, route: RouteOptions): void {
  const existing = route.preHandler === undefined ? [] : [route.preHandler].flat();
  const limit = scope.tenantRateLimit;
  route.preHandler =
    existing.length > 0 ? [scope.requireApiKey, ...existing] : [scope.requireApiKey, ...(limit ? [limit] : [])];
}
