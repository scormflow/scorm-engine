import type { EngineEvent, EventTransport } from './types.js';

/**
 * The default transport: events never leave the process.
 *
 * Delivery starts synchronously inside `publish`, so a handler sees the event
 * before the publishing request has even answered. There is no retry — a
 * handler that fails has already been logged by the bus — and nothing survives
 * a restart; run the Redis transport when either matters.
 */
export class MemoryTransport implements EventTransport {
  readonly name = 'memory';
  private onConsume: ((event: EngineEvent) => Promise<void>) | undefined;
  private onBroadcast: ((event: EngineEvent) => void) | undefined;

  publish(event: EngineEvent): Promise<void> {
    this.onBroadcast?.(event);
    // Work failures were logged by the bus; there is nowhere to redeliver them.
    return this.onConsume?.(event).catch(() => undefined) ?? Promise.resolve();
  }

  consume(handler: (event: EngineEvent) => Promise<void>): void {
    this.onConsume = handler;
  }

  broadcast(handler: (event: EngineEvent) => void): void {
    this.onBroadcast = handler;
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {}
}
