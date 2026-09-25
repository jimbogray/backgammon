import type { GameSummary, GameView, MatchSummary, PlayerInfo } from '../shared/api';
import type { Action, Move } from '../shared/engine';

/**
 * Where the API lives. Empty in development, where Vite proxies /api to the
 * local server; set VITE_API_URL at build time when the API has its own address.
 */
export const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

const TOKEN_KEY = 'bg_session';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Saves (or with null, forgets) the session token sent with every API call. */
export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private browsing without storage: the session lasts until the tab closes.
  }
  memoryToken = token;
}

let memoryToken = readToken();

export function authHeaders(): Record<string, string> {
  return memoryToken ? { Authorization: `Bearer ${memoryToken}` } : {};
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(API_URL + path, {
    method,
    headers: { ...authHeaders(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401) setToken(null);
  if (!res.ok) throw new ApiError(String(data.error ?? `Request failed (${res.status})`), res.status, data);
  return data as T;
}

/** Calls an endpoint that signs the user in, and keeps the session token it returns. */
async function signIn(path: string, body: unknown): Promise<{ user: Me['user'] }> {
  const res = await call<{ user: Me['user']; token: string }>('POST', path, body);
  setToken(res.token);
  return res;
}

export interface Me {
  user: { id: number; username: string; email: string | null };
  record: { wins: number; losses: number };
}

export const api = {
  me: () => call<Me>('GET', '/api/me'),
  providers: () => call<{ google: boolean }>('GET', '/api/auth/providers'),
  signup: (username: string, email: string, password: string) =>
    signIn('/api/auth/signup', { username, email, password }),
  login: (login: string, password: string) => signIn('/api/auth/login', { login, password }),
  finishGoogleSignIn: (code: string) => signIn('/api/auth/google/exchange', { code }),
  logout: async () => {
    try {
      await call<{ ok: true }>('POST', '/api/auth/logout', {});
    } finally {
      setToken(null);
    }
  },
  rename: (username: string) => call<{ user: Me['user'] }>('PATCH', '/api/me', { username }),

  players: () => call<{ players: PlayerInfo[] }>('GET', '/api/players'),
  games: () => call<{ games: GameSummary[] }>('GET', '/api/games'),
  matches: () => call<{ matches: MatchSummary[] }>('GET', '/api/matches'),
  game: (id: string) => call<{ game: GameView }>('GET', `/api/games/${id}`),
  challenge: (opponent: string) => call<{ game: GameView }>('POST', '/api/games', { opponent }),
  createInvite: () => call<{ game: GameView }>('POST', '/api/games', {}),
  cancelInvite: (id: string) => call<{ ok: true }>('DELETE', `/api/games/${id}`, {}),
  invite: (code: string) =>
    call<{ gameId: string; from: PlayerInfo; status: string; joined: boolean }>('GET', `/api/invites/${code}`),
  joinInvite: (code: string) => call<{ game: GameView }>('POST', `/api/invites/${code}/join`, {}),
  act: (id: string, action: Action, version: number) =>
    call<{ game: GameView }>('POST', `/api/games/${id}/actions`, { action, version }),
  preview: (id: string, moves: Move[], version: number) =>
    call<Record<string, never>>('POST', `/api/games/${id}/preview`, { moves, version }),
};

export function googleSignInUrl(next: string): string {
  return `${API_URL}/api/auth/google?next=${encodeURIComponent(next)}`;
}

export function inviteUrl(code: string): string {
  return `${window.location.origin}/join/${code}`;
}
