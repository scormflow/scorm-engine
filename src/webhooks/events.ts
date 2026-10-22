/**
 * The events the engine publishes to webhook endpoints.
 *
 * Services report what happened through an {@link EventSink}; they never know
 * whether anyone is listening. The webhook dispatcher is the production sink,
 * and anything else (a log, a queue, a test spy) can stand in for it.
 */

export const WEBHOOK_EVENT_TYPES = [
  // SCORM attempts
  'attempt.started',
  'attempt.suspended',
  'attempt.terminated',
  'course.completed',
  'course.passed',
  'course.failed',
  'score.updated',
  'objective.mastered',
  // Course versioning
  'course.version.published',
  'course.version.rolled_back',
  // Certificates
  'certificate.issued',
  'certificate.revoked',
  // cmi5
  'cmi5.session.terminated',
  'cmi5.session.abandoned',
  'cmi5.au.waived',
  'cmi5.block.satisfied',
  'cmi5.course.satisfied',
  // LRS
  'xapi.statement.stored',
  // AI analytics: a config's monthly token usage reached its alert threshold or cap.
  'ai.budget.alert',
  // Sent only by the "send test event" endpoint.
  'webhook.test',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** Subscribes an endpoint to every event, including ones added later. */
export const ALL_EVENTS = '*';

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

export interface EventSink {
  /**
   * Report an event. Never throws and never blocks the caller: delivery is the
   * sink's problem, not the request's.
   */
  emit(tenantId: string, type: WebhookEventType, data: Record<string, unknown>): void;
}

export const NOOP_SINK: EventSink = { emit: () => undefined };

/** The JSON body of every delivery. */
export interface WebhookPayload {
  /** Event id, shared by every endpoint's copy — dedupe on this. */
  id: string;
  type: WebhookEventType;
  createdAt: string;
  data: Record<string, unknown>;
}
