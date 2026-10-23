import type { EngineEvent } from '../events/index.js';
import type { WebhookEventType } from '../webhooks/events.js';
import { definePlugin, type ScormflowPlugin } from './types.js';

/**
 * Live activity analytics.
 *
 * Counts each tenant's engine events per minute over a rolling window, so a
 * dashboard can show what is happening right now (launches, completions,
 * statements) without querying attempt tables. It listens rather than
 * subscribes: on a shared Redis bus every instance sees every event, so any
 * instance can answer. Counts live in memory and start from zero when the
 * process restarts — the database-backed `/analytics` endpoints are the record.
 *
 * Route: `GET /api/v1/plugins/analytics/activity?minutes=N`.
 */

export interface AnalyticsPluginOptions {
  /** Minutes of history kept and the largest `?minutes=` accepted. Default 60, max 1440. */
  retentionMinutes?: number;
  /** Clock, for tests. */
  now?: () => Date;
}

export interface ActivityBucket {
  /** Start of the minute, ISO 8601. */
  minute: string;
  total: number;
  counts: Partial<Record<WebhookEventType, number>>;
}

export interface ActivityReport {
  windowMinutes: number;
  /** Start of the oldest minute in `timeline`. */
  since: string;
  total: number;
  totals: Partial<Record<WebhookEventType, number>>;
  /** One entry per minute, oldest first, including empty minutes. */
  timeline: ActivityBucket[];
}

const MINUTE_MS = 60_000;
const MAX_RETENTION_MINUTES = 1440;

/** Per-tenant counters: minute index (epoch minutes) → event type → count. */
export class ActivityCounter {
  private readonly tenants = new Map<string, Map<number, Map<string, number>>>();

  constructor(
    readonly retentionMinutes: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(event: Pick<EngineEvent, 'tenantId' | 'type'>): void {
    const minute = this.currentMinute();
    let minutes = this.tenants.get(event.tenantId);
    if (!minutes) {
      minutes = new Map();
      this.tenants.set(event.tenantId, minutes);
    }
    let counts = minutes.get(minute);
    if (!counts) {
      counts = new Map();
      minutes.set(minute, counts);
      this.prune(minutes, minute);
    }
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }

  report(tenantId: string, windowMinutes: number): ActivityReport {
    const window = Math.min(Math.max(1, Math.floor(windowMinutes)), this.retentionMinutes);
    const last = this.currentMinute();
    const first = last - window + 1;
    const minutes = this.tenants.get(tenantId);
    const totals: Partial<Record<WebhookEventType, number>> = {};
    const timeline: ActivityBucket[] = [];
    let total = 0;
    for (let m = first; m <= last; m++) {
      const bucket: ActivityBucket = { minute: new Date(m * MINUTE_MS).toISOString(), total: 0, counts: {} };
      for (const [type, n] of minutes?.get(m) ?? []) {
        const key = type as WebhookEventType;
        bucket.counts[key] = n;
        bucket.total += n;
        totals[key] = (totals[key] ?? 0) + n;
      }
      total += bucket.total;
      timeline.push(bucket);
    }
    return { windowMinutes: window, since: new Date(first * MINUTE_MS).toISOString(), total, totals, timeline };
  }

  clear(): void {
    this.tenants.clear();
  }

  private currentMinute(): number {
    return Math.floor(this.now().getTime() / MINUTE_MS);
  }

  private prune(minutes: Map<number, Map<string, number>>, current: number): void {
    const oldest = current - this.retentionMinutes + 1;
    for (const m of minutes.keys()) if (m < oldest) minutes.delete(m);
  }
}

export function analyticsPlugin(options: AnalyticsPluginOptions = {}): ScormflowPlugin {
  const retention = options.retentionMinutes ?? 60;
  if (!Number.isInteger(retention) || retention < 1 || retention > MAX_RETENTION_MINUTES) {
    throw new RangeError(`retentionMinutes must be an integer from 1 to ${MAX_RETENTION_MINUTES}`);
  }

  return definePlugin({
    name: 'analytics',
    version: '1.0.0',
    setup(ctx) {
      const counter = new ActivityCounter(retention, options.now);
      ctx.listen((event) => {
        // The "send test event" endpoint is not activity.
        if (event.type !== 'webhook.test') counter.record(event);
      });
      ctx.onClose(() => counter.clear());

      ctx.routes((app) => {
        app.get<{ Querystring: { minutes?: string } }>('/activity', async (req, reply) => {
          const raw = req.query.minutes;
          const minutes = raw === undefined || raw === '' ? retention : Number(raw);
          if (!Number.isInteger(minutes) || minutes < 1 || minutes > retention) {
            return reply.code(400).send({
              code: 'invalid_request',
              message: `minutes must be an integer from 1 to ${retention}`,
            });
          }
          return counter.report(req.tenantId, minutes);
        });
      });
    },
  });
}
