import type { GameSummary, GameView, PlayerInfo } from '../shared/api';
import type { Action } from '../shared/engine';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: Record<string, unknown>,
  ) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ApiError(String(data.error ?? `Request failed (${res.status})`), res.status, data);
  return data as T;
}

export interface Me {
  user: { id: number; username: string; email: string | null };
  record: { wins: number; losses: number };
}

export const api = {
  me: () => call<Me>('GET', '/api/me'),
  providers: () => call<{ google: boolean }>('GET', '/api/auth/providers'),
  signup: (username: string, email: string, password: string) =>
    call<{ user: Me['user'] }>('POST', '/api/auth/signup', { username, email, password }),
  login: (login: string, password: string) => call<{ user: Me['user'] }>('POST', '/api/auth/login', { login, password }),
  logout: () => call<{ ok: true }>('POST', '/api/auth/logout', {}),
  rename: (username: string) => call<{ user: Me['user'] }>('PATCH', '/api/me', { username }),

  games: () => call<{ games: GameSummary[] }>('GET', '/api/games'),
  game: (id: string) => call<{ game: GameView }>('GET', `/api/games/${id}`),
  challenge: (opponent: string) => call<{ game: GameView }>('POST', '/api/games', { opponent }),
  createInvite: () => call<{ game: GameView }>('POST', '/api/games', {}),
  cancelInvite: (id: string) => call<{ ok: true }>('DELETE', `/api/games/${id}`, {}),
  invite: (code: string) =>
    call<{ gameId: string; from: PlayerInfo; status: string; joined: boolean }>('GET', `/api/invites/${code}`),
  joinInvite: (code: string) => call<{ game: GameView }>('POST', `/api/invites/${code}/join`, {}),
  act: (id: string, action: Action, version: number) =>
    call<{ game: GameView }>('POST', `/api/games/${id}/actions`, { action, version }),
};

export function inviteUrl(code: string): string {
  return `${window.location.origin}/join/${code}`;
}
