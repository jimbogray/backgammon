import type { Response } from 'express';

/**
 * In-process fan-out of "something changed" notices to connected browsers via
 * Server-Sent Events. Each user can have several tabs open. Clients refetch
 * the data they need when a notice arrives, so the payload stays tiny.
 */
export class EventHub {
  private streams = new Map<number, Set<Response>>();

  add(userId: number, res: Response): () => void {
    let set = this.streams.get(userId);
    if (!set) {
      set = new Set();
      this.streams.set(userId, set);
    }
    set.add(res);
    return () => {
      set!.delete(res);
      if (set!.size === 0) this.streams.delete(userId);
    };
  }

  notify(userIds: Array<number | null | undefined>, event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const id of new Set(userIds)) {
      if (id == null) continue;
      for (const res of this.streams.get(id) ?? []) res.write(payload);
    }
  }
}
