import { useEffect, useRef } from 'react';

type Listener = (data: { id: string; version: number }) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;

function ensureSource() {
  if (source) return;
  source = new EventSource('/api/events');
  source.addEventListener('game', (e) => {
    const data = JSON.parse((e as MessageEvent).data);
    for (const l of listeners) l(data);
  });
  // After a dropped connection the browser reconnects on its own; tell
  // listeners to refetch in case they missed something while offline.
  source.addEventListener('ready', () => {
    for (const l of listeners) l({ id: '*', version: -1 });
  });
}

export function closeEvents() {
  source?.close();
  source = null;
}

/** Call `onChange` whenever one of the signed-in user's games changes. */
export function useGameEvents(onChange: Listener) {
  const ref = useRef(onChange);
  ref.current = onChange;
  useEffect(() => {
    const l: Listener = (d) => ref.current(d);
    listeners.add(l);
    ensureSource();
    return () => {
      listeners.delete(l);
    };
  }, []);
}
