import type { Response } from 'express';

export interface EventMessage {
  /** Who should hear about it, or '*' for every connected browser. */
  userIds: number[] | '*';
  event: string;
  data: unknown;
}

/**
 * Fan-out of "something changed" notices to connected browsers via
 * Server-Sent Events. Each user can have several tabs open. Clients refetch
 * the data they need when a notice arrives, so the payload stays tiny.
 *
 * With a `publish` function (Postgres NOTIFY in production) notices go to
 * every API server, each of which calls `receive` and writes to the browsers
 * connected to it. Without one, notices stay in this process.
 */
/** Open streams one user may hold on one server; a new tab past this closes their oldest. */
export const MAX_STREAMS_PER_USER = 5;
/** Open streams one server will hold in total. */
export const MAX_STREAMS = 2000;

export class EventHub {
  private streams = new Map<number, Set<Response>>();
  private total = 0;

  constructor(private publish?: (message: string) => Promise<void>) {}

  /** Starts sending this user's notices to `res`. Returns null when the server is full. */
  add(userId: number, res: Response): (() => void) | null {
    let set = this.streams.get(userId);
    if (set && set.size >= MAX_STREAMS_PER_USER) {
      // Newest tab wins. The replaced tab waits a while before reconnecting (see client/events.ts).
      const oldest = set.values().next().value!;
      set.delete(oldest);
      this.total--;
      oldest.write('event: replaced\ndata: {}\n\n');
      oldest.end();
    }
    if (this.total >= MAX_STREAMS) return null;
    if (!set) {
      set = new Set();
      this.streams.set(userId, set);
    }
    set.add(res);
    this.total++;
    return () => {
      if (!set!.delete(res)) return;
      this.total--;
      if (set!.size === 0) this.streams.delete(userId);
    };
  }

  async notify(userIds: Array<number | null | undefined> | '*', event: string, data: unknown): Promise<void> {
    const message: EventMessage = {
      userIds: userIds === '*' ? '*' : [...new Set(userIds)].filter((id): id is number => id != null),
      event,
      data,
    };
    if (!this.publish) {
      this.deliver(message);
      return;
    }
    try {
      await this.publish(JSON.stringify(message));
    } catch (err) {
      // The change itself is saved; browsers catch up on their next refresh.
      console.error('Publishing a live update failed:', err);
    }
  }

  /** Handles a message published by any server. */
  receive = (payload: string): void => {
    try {
      this.deliver(JSON.parse(payload) as EventMessage);
    } catch (err) {
      console.error('Ignoring a malformed live update:', err);
    }
  };

  /** Tells every connected browser to refetch, after updates may have been missed. */
  resync = (): void => {
    for (const set of this.streams.values()) for (const res of set) res.write('event: ready\ndata: {}\n\n');
  };

  private deliver({ userIds, event, data }: EventMessage): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (userIds === '*') {
      for (const set of this.streams.values()) for (const res of set) res.write(payload);
      return;
    }
    for (const id of userIds) {
      for (const res of this.streams.get(id) ?? []) res.write(payload);
    }
  }
}
