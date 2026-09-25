import { useEffect, useRef } from 'react';
import type { GameEvent, MovePreview } from '../shared/api';
import { API_URL, authHeaders } from './api';

/**
 * `game`: a game changed (refetch it). `preview`: checkers moved in a turn not
 * yet confirmed. `resync`: the stream (re)connected, so refetch everything.
 */
export type LiveEvent =
  | ({ kind: 'game' } & GameEvent)
  | ({ kind: 'preview' } & MovePreview)
  | { kind: 'resync' };

type Listener = (event: LiveEvent) => void;

const listeners = new Set<Listener>();
let controller: AbortController | null = null;

function emit(event: LiveEvent) {
  for (const l of listeners) l(event);
}

/**
 * Reads the Server-Sent Events stream with fetch rather than EventSource,
 * because EventSource can't send the Authorization header the API needs.
 * Reconnects with backoff when the connection drops (the API closes long
 * requests now and then, and replicas come and go on deploys).
 */
async function run(signal: AbortSignal) {
  let failures = 0;
  while (!signal.aborted) {
    try {
      const res = await fetch(`${API_URL}/api/events`, { headers: authHeaders(), signal });
      if (res.status === 401) {
        // Signed out; the next sign-in starts a fresh stream.
        if (controller?.signal === signal) controller = null;
        return;
      }
      if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if ((event === 'game' || event === 'preview') && data) emit({ kind: event, ...JSON.parse(data) });
          // After a (re)connect, refetch in case something changed while offline.
          if (event === 'ready') {
            failures = 0;
            emit({ kind: 'resync' });
          }
        }
      }
    } catch {
      if (signal.aborted) return;
      failures++;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** failures)));
  }
}

function ensureStream() {
  if (controller) return;
  controller = new AbortController();
  void run(controller.signal);
}

export function closeEvents() {
  controller?.abort();
  controller = null;
}

/** Call `onEvent` for live activity in any of the signed-in user's games. */
export function useGameEvents(onEvent: Listener) {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => {
    const l: Listener = (d) => ref.current(d);
    listeners.add(l);
    ensureStream();
    return () => {
      listeners.delete(l);
    };
  }, []);
}
