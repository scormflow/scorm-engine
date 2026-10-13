import type { WebhookEventType } from '../webhooks/events.js';

/**
 * One thing that happened inside the engine, as it travels over the event bus.
 *
 * The id is minted once, when the event is published, and survives every hop:
 * the webhook payload, the live event stream and any Redis consumer all see
 * the same `evt_…` id, so receivers can dedupe on it.
 */
export interface EngineEvent {
  id: string;
  tenantId: string;
  type: WebhookEventType;
  /** ISO 8601 timestamp of when the event was published. */
  createdAt: string;
  data: Record<string, unknown>;
}

export type EventHandler = (event: EngineEvent) => void | Promise<void>;

export interface EventBusLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

/**
 * Moves events from publishers to handlers. The bus owns subscribers and
 * fan-out; a transport only decides *where* events travel.
 *
 * There are two ways to receive:
 *  - `consume` — work delivery. Each event reaches **one** engine instance
 *    among all those sharing the transport (a Redis consumer group, say).
 *    Webhook enqueueing hangs off this so a cluster sends each webhook once.
 *    A handler that rejects asks for redelivery, if the transport can retry.
 *  - `broadcast` — every instance sees every event. Live streams to
 *    connected clients hang off this, because the client is connected to
 *    whichever instance it happened to reach.
 */
export interface EventTransport {
  /** Human-readable driver name (`memory`, `redis`), for logs and health. */
  readonly name: string;
  /** Resolves once the event is durably handed over (or delivered, in-process). */
  publish(event: EngineEvent): Promise<void>;
  /** Register the bus's work handler. Called at most once, before `start`. */
  consume(handler: (event: EngineEvent) => Promise<void>): void;
  /** Register the bus's broadcast handler. Called at most once, before `start`. */
  broadcast(handler: (event: EngineEvent) => void): void;
  /** Begin receiving. */
  start(): Promise<void>;
  /** Stop receiving and release connections. */
  close(): Promise<void>;
}
