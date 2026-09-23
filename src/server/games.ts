import crypto from 'node:crypto';
import { Router } from 'express';
import { Action, applyAction, Color, GameError, GameState, newGame, Roller } from '../shared/engine.js';
import type { GameSummary, GameView, PlayerInfo } from '../shared/api.js';
import { requireUser, User } from './auth.js';
import type { DB } from './db.js';
import type { EventHub } from './events.js';

interface GameRow {
  id: string;
  created_by: number;
  white_id: number | null;
  black_id: number | null;
  status: 'waiting' | 'active' | 'finished';
  invite_code: string | null;
  state: string | null;
  version: number;
  winner_id: number | null;
  points: number | null;
  created_at: string;
  updated_at: string;
}

const ACTION_TYPES = new Set(['roll', 'move', 'double', 'take', 'drop', 'resign']);

export const secureRoll: Roller = () => crypto.randomInt(1, 7);

function newId(bytes = 9): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function colorOf(row: GameRow, userId: number): Color | null {
  if (row.white_id === userId) return 'white';
  if (row.black_id === userId) return 'black';
  return null;
}

/** Whose move it is: the player on turn, or the player who must answer a double. */
export function awaiting(state: GameState): Color | null {
  if (state.phase === 'finished') return null;
  if (state.phase === 'doubling') return state.doubleOfferedBy === 'white' ? 'black' : 'white';
  return state.turn;
}

export interface GameDeps {
  db: DB;
  hub: EventHub;
  roll?: Roller;
}

export function gamesRouter({ db, hub, roll = secureRoll }: GameDeps): Router {
  const router = Router();

  const getRow = db.prepare('SELECT * FROM games WHERE id = ?');
  const getUser = db.prepare('SELECT id, username FROM users WHERE id = ?');

  function player(id: number | null): PlayerInfo | null {
    return id == null ? null : ((getUser.get(id) as PlayerInfo | undefined) ?? null);
  }

  function view(row: GameRow, userId: number): GameView {
    const you = colorOf(row, userId);
    return {
      id: row.id,
      status: row.status,
      version: row.version,
      you,
      players: { white: player(row.white_id), black: player(row.black_id) },
      createdBy: row.created_by,
      inviteCode: row.status === 'waiting' && row.created_by === userId ? row.invite_code : null,
      state: row.state ? (JSON.parse(row.state) as GameState) : null,
      updatedAt: row.updated_at,
    };
  }

  function canSee(row: GameRow, userId: number): boolean {
    return row.white_id === userId || row.black_id === userId || row.created_by === userId;
  }

  function participants(row: GameRow): number[] {
    return [row.white_id, row.black_id, row.created_by].filter((id): id is number => id != null);
  }

  function announce(row: GameRow): void {
    hub.notify(participants(row), 'game', { id: row.id, version: row.version });
  }

  router.use('/api', requireUser);

  // Server-Sent Events: tells the browser when any of this user's games change.
  router.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('event: ready\ndata: {}\n\n');
    const remove = hub.add(req.user!.id, res);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      remove();
    });
  });

  router.get('/api/games', (req, res) => {
    const userId = req.user!.id;
    const rows = db
      .prepare(
        `SELECT * FROM games WHERE white_id = @id OR black_id = @id OR (status = 'waiting' AND created_by = @id)
         ORDER BY updated_at DESC, created_at DESC LIMIT 200`,
      )
      .all({ id: userId }) as GameRow[];
    const games: GameSummary[] = rows.map((row) => {
      const you = colorOf(row, userId);
      const state = row.state ? (JSON.parse(row.state) as GameState) : null;
      const opponentId = you === 'white' ? row.black_id : row.white_id;
      return {
        id: row.id,
        status: row.status,
        you,
        opponent: player(opponentId),
        yourTurn: Boolean(state && you && awaiting(state) === you),
        inviteCode: row.status === 'waiting' ? row.invite_code : null,
        result:
          state?.result && you
            ? { won: state.result.winner === you, points: state.result.points, reason: state.result.reason }
            : null,
        updatedAt: row.updated_at,
      };
    });
    res.json({ games });
  });

  // Start a game against a registered player, or create an invite link.
  router.post('/api/games', (req, res) => {
    const me = req.user!;
    const opponentName = typeof req.body?.opponent === 'string' ? req.body.opponent.trim() : '';
    const id = newId();

    if (!opponentName) {
      const inviteCode = newId(12);
      db.prepare(
        `INSERT INTO games (id, created_by, white_id, status, invite_code) VALUES (?, ?, ?, 'waiting', ?)`,
      ).run(id, me.id, me.id, inviteCode);
      const row = getRow.get(id) as GameRow;
      res.status(201).json({ game: view(row, me.id) });
      return;
    }

    const opponent = db.prepare('SELECT id, username FROM users WHERE username = ?').get(opponentName) as
      | User
      | undefined;
    if (!opponent) {
      res.status(404).json({ error: `No player named "${opponentName}". Send them an invite link instead.` });
      return;
    }
    if (opponent.id === me.id) {
      res.status(400).json({ error: "You can't play against yourself" });
      return;
    }
    const state = newGame(roll);
    db.prepare(
      `INSERT INTO games (id, created_by, white_id, black_id, status, state, version) VALUES (?, ?, ?, ?, 'active', ?, 1)`,
    ).run(id, me.id, me.id, opponent.id, JSON.stringify(state));
    const row = getRow.get(id) as GameRow;
    announce(row);
    res.status(201).json({ game: view(row, me.id) });
  });

  router.get('/api/invites/:code', (req, res) => {
    const row = db.prepare('SELECT * FROM games WHERE invite_code = ?').get(req.params.code) as GameRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'This invite link is not valid' });
      return;
    }
    res.json({
      gameId: row.id,
      from: player(row.created_by),
      status: row.status,
      joined: canSee(row, req.user!.id),
    });
  });

  router.post('/api/invites/:code/join', (req, res) => {
    const me = req.user!;
    const result = db.transaction(() => {
      const row = db.prepare('SELECT * FROM games WHERE invite_code = ?').get(req.params.code) as GameRow | undefined;
      if (!row) return { status: 404, error: 'This invite link is not valid' } as const;
      if (canSee(row, me.id) && row.status !== 'waiting') return { row } as const;
      if (row.created_by === me.id) return { status: 400, error: 'Share this link with your opponent' } as const;
      if (row.status !== 'waiting') return { status: 409, error: 'Someone else already joined this game' } as const;
      const state = newGame(roll);
      db.prepare(
        `UPDATE games SET black_id = ?, status = 'active', state = ?, version = version + 1, updated_at = datetime('now')
         WHERE id = ? AND status = 'waiting'`,
      ).run(me.id, JSON.stringify(state), row.id);
      return { row: getRow.get(row.id) as GameRow } as const;
    })();
    if ('error' in result) {
      res.status(result.status!).json({ error: result.error });
      return;
    }
    announce(result.row);
    res.json({ game: view(result.row, me.id) });
  });

  router.get('/api/games/:id', (req, res) => {
    const row = getRow.get(req.params.id) as GameRow | undefined;
    if (!row || !canSee(row, req.user!.id)) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }
    res.json({ game: view(row, req.user!.id) });
  });

  router.get('/api/games/:id/history', (req, res) => {
    const row = getRow.get(req.params.id) as GameRow | undefined;
    if (!row || !canSee(row, req.user!.id)) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }
    const actions = db
      .prepare(
        `SELECT a.action, a.created_at AS at, u.username FROM game_actions a JOIN users u ON u.id = a.user_id
         WHERE a.game_id = ? ORDER BY a.id`,
      )
      .all(row.id) as Array<{ action: string; at: string; username: string }>;
    res.json({ actions: actions.map((a) => ({ ...a, action: JSON.parse(a.action) })) });
  });

  router.delete('/api/games/:id', (req, res) => {
    const row = getRow.get(req.params.id) as GameRow | undefined;
    if (!row || row.created_by !== req.user!.id || row.status !== 'waiting') {
      res.status(404).json({ error: 'Only an unanswered invite can be cancelled' });
      return;
    }
    db.prepare(`DELETE FROM games WHERE id = ? AND status = 'waiting'`).run(row.id);
    res.json({ ok: true });
  });

  // Every game action goes through here. The client sends the version it last
  // saw so that two tabs (or two players) can't act on a stale position.
  router.post('/api/games/:id/actions', (req, res) => {
    const me = req.user!;
    const action = req.body?.action as Action | undefined;
    const expectedVersion = Number(req.body?.version);
    if (!action || typeof action !== 'object' || !ACTION_TYPES.has(action.type)) {
      res.status(400).json({ error: 'Unknown action' });
      return;
    }

    const outcome = db.transaction(() => {
      const row = getRow.get(req.params.id) as GameRow | undefined;
      if (!row || !canSee(row, me.id)) return { status: 404, error: 'Game not found' } as const;
      const color = colorOf(row, me.id);
      if (row.status !== 'active' || !row.state || !color) {
        return { status: 409, error: 'This game is not in progress', row } as const;
      }
      if (Number.isFinite(expectedVersion) && expectedVersion !== row.version) {
        return { status: 409, error: 'The game has moved on. Showing the latest position.', row } as const;
      }
      let next: GameState;
      try {
        next = applyAction(JSON.parse(row.state) as GameState, color, action, roll);
      } catch (err) {
        if (err instanceof GameError) return { status: 400, error: err.message, row } as const;
        throw err;
      }
      const finished = next.phase === 'finished';
      const winnerId = finished && next.result ? (next.result.winner === 'white' ? row.white_id : row.black_id) : null;
      db.prepare(
        `UPDATE games SET state = ?, version = version + 1, status = ?, winner_id = ?, points = ?, updated_at = datetime('now')
         WHERE id = ? AND version = ?`,
      ).run(JSON.stringify(next), finished ? 'finished' : 'active', winnerId, next.result?.points ?? null, row.id, row.version);
      const logged = action.type === 'move' ? { type: 'move', moves: next.lastTurn?.moves ?? [] } : { type: action.type };
      const withDice = action.type === 'roll' ? { ...logged, dice: next.dice ?? next.lastTurn?.dice } : logged;
      db.prepare('INSERT INTO game_actions (game_id, user_id, action) VALUES (?, ?, ?)').run(
        row.id,
        me.id,
        JSON.stringify(withDice),
      );
      return { row: getRow.get(row.id) as GameRow } as const;
    })();

    if ('error' in outcome) {
      const body: Record<string, unknown> = { error: outcome.error };
      if ('row' in outcome && outcome.row) body.game = view(outcome.row, me.id);
      res.status(outcome.status!).json(body);
      return;
    }
    announce(outcome.row);
    res.json({ game: view(outcome.row, me.id) });
  });

  return router;
}
