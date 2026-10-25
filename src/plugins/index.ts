import type { Env } from '../config/env.js';
import { analyticsPlugin } from './analytics.js';
import type { ScormflowPlugin } from './types.js';

export {
  ActivityCounter,
  analyticsPlugin,
  type ActivityBucket,
  type ActivityReport,
  type AnalyticsPluginOptions,
} from './analytics.js';
export {
  installPlugins,
  PluginError,
  type InstalledPlugin,
  type PluginHost,
  type PluginHostDeps,
} from './host.js';
export { definePlugin, type PluginContext, type PluginRoutes, type ScormflowPlugin } from './types.js';

/** The built-in plugins `PLUGINS` names, with default options. */
export function pluginsFromEnv(env: Pick<Env, 'PLUGINS'>): ScormflowPlugin[] {
  return env.PLUGINS.map((name) => {
    switch (name) {
      case 'analytics':
        return analyticsPlugin();
    }
  });
}
