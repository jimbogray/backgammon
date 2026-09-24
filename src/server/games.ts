import crypto from 'node:crypto';
import { Router } from 'express';
import { Action, applyAction, Color, GameError, GameState, newGame, Roller } from '../shared/engine.js';
import type { GameSummary, GameView, PlayerInfo } from '../shared/api.js';
import { requireUser, User } from './auth.js';
import type { Database, Queryable } from './db.js';
import type { EventHub } from './events.js';

interface GameRow {
  id: string;
  created_by: number;
  white_id: number | null;
  black_id: number | null;
  status: 'waiting' | 'active' | 'finished';
  invite_code: string | null;
  state: GameState | null;
  version: number;
  winner_id: number | null;
  points: number | null;
  created_at: Date;
  updated_at: Date;
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
  db: Database;
  hub: EventHub;
  roll?: Roller;
}

export function gamesRouter({ db, hub, roll = secureRoll }: GameDeps): Router {
  const router = Router();

  async function getRow(q: Queryable, id: string, lock = false): Promise<GameRow | undefined> {
    const { rows } = await q.query<GameRow>(`SELECT * FROM games WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0];
  }

  /** Looks up usernames for a batch of user ids. */
  async function players(ids: Array<number | null>): Promise<Map<number, PlayerInfo>> {
    const wanted = [...new Set(ids.filter((id): id is number => id != null))];
    if (wanted.length === 0) return new Map();
    const { rows } = await db.query<PlayerInfo>('SELECT id, username FROM users WHERE id = ANY($1::int[])', [wanted]);
    return new Map(rows.map((p) => [p.id, p]));
  }

  async function player(id: number | null): Promise<PlayerInfo | null> {
    return id == null ? null : ((await players([id])).get(id) ?? null);
  }

  async function view(row: GameRow, userId: number): Promise<GameView> {
    const you = colorOf(row, userId);
    const names = await players([row.white_id, row.black_id]);
    return {
      id: row.id,
      status: row.status,
      version: row.version,
      you,
      players: {
        white: row.white_id == null ? null : (names.get(row.white_id) ?? null),
        black: row.black_id == null ? null : (names.get(row.black_id) ?? null),
      },
      createdBy: row.created_by,
      inviteCode: row.status === 'waiting' && row.created_by === userId ? row.invite_code : null,
      state: row.state,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  function canSee(row: GameRow, userId: number): boolean {
    return row.white_id === userId || row.black_id === userId || row.created_by === userId;
  }

  function participants(row: GameRow): number[] {
    return [row.white_id, row.black_id, row.created_by].filter((id): id is number => id != null);
  }

  function announce(row: GameRow): Promise<void> {
    return hub.notify(participants(row), 'game', { id: row.id, version: row.version });
  }

  router.use('/api', requireUser);

  // Server-Sent Events: tells the browser when any of this user's games change.
  router.get('/api/events', (req, res) => {
    const remove = hub.add(req.user!.id, res);
    if (!remove) {
      res.status(503).json({ error: 'Live updates are busy. Please try again shortly.' });
      return;
    }
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('event: ready\ndata: {}\n\n');
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      remove();
    });
  });

  router.get('/api/games', async (req, res) => {
    const userId = req.user!.id;
    const { rows } = await db.query<GameRow>(
      `SELECT * FROM games WHERE white_id = $1 OR black_id = $1 OR (status = 'waiting' AND created_by = $1)
       ORDER BY updated_at DESC, created_at DESC LIMIT 200`,
      [userId],
    );
    const opponentOf = (row: GameRow) => (colorOf(row, userId) === 'white' ? row.black_id : row.white_id);
    const names = await players(rows.map(opponentOf));
    const games: GameSummary[] = rows.map((row) => {
      const you = colorOf(row, userId);
      const state = row.state;
      const opponentId = opponentOf(row);
      return {
        id: row.id,
        status: row.status,
        you,
        opponent: opponentId == null ? null : (names.get(opponentId) ?? null),
        yourTurn: Boolean(state && you && awaiting(state) === you),
        inviteCode: row.status === 'waiting' ? row.invite_code : null,
        result:
          state?.result && you
            ? { won: state.result.winner === you, points: state.result.points, reason: state.result.reason }
            : null,
        updatedAt: row.updated_at.toISOString(),
      };
    });
    res.json({ games });
  });

  // Start a game against a registered player, or create an invite link.
  router.post('/api/games', async (req, res) => {
    const me = req.user!;
    const opponentName = typeof req.body?.opponent === 'string' ? req.body.opponent.trim() : '';
    const id = newId();

    if (!opponentName) {
      const inviteCode = newId(12);
      const { rows } = await db.query<GameRow>(
        `INSERT INTO games (id, created_by, white_id, status, invite_code) VALUES ($1, $2, $2, 'waiting', $3) RETURNING *`,
        [id, me.id, inviteCode],
      );
      res.status(201).json({ game: await view(rows[0], me.id) });
      return;
    }

    const found = await db.query<User>('SELECT id, username FROM users WHERE lower(username) = lower($1)', [
      opponentName,
    ]);
    const opponent = found.rows[0];
    if (!opponent) {
      res.status(404).json({ error: `No player named "${opponentName}". Send them an invite link instead.` });
      return;
    }
    if (opponent.id === me.id) {
      res.status(400).json({ error: "You can't play against yourself" });
      return;
    }
    const state = newGame(roll);
    const { rows } = await db.query<GameRow>(
      `INSERT INTO games (id, created_by, white_id, black_id, status, state, version)
       VALUES ($1, $2, $2, $3, 'active', $4, 1) RETURNING *`,
      [id, me.id, opponent.id, JSON.stringify(state)],
    );
    await announce(rows[0]);
    res.status(201).json({ game: await view(rows[0], me.id) });
  });

  router.get('/api/invites/:code', async (req, res) => {
    const { rows } = await db.query<GameRow>('SELECT * FROM games WHERE invite_code = $1', [req.params.code]);
    const row = rows[0];
    if (!row) {
      res.status(404).json({ error: 'This invite link is not valid' });
      return;
    }
    res.json({
      gameId: row.id,
      from: await player(row.created_by),
      status: row.status,
      joined: canSee(row, req.user!.id),
    });
  });

  router.post('/api/invites/:code/join', async (req, res) => {
    const me = req.user!;
    const result = await db.transaction(async (tx) => {
      const found = await tx.query<GameRow>('SELECT * FROM games WHERE invite_code = $1 FOR UPDATE', [req.params.code]);
      const row = found.rows[0];
      if (!row) return { status: 404, error: 'This invite link is not valid' } as const;
      if (canSee(row, me.id) && row.status !== 'waiting') return { row } as const;
      if (row.created_by === me.id) return { status: 400, error: 'Share this link with your opponent' } as const;
      if (row.status !== 'waiting') return { status: 409, error: 'Someone else already joined this game' } as const;
      const state = newGame(roll);
      const updated = await tx.query<GameRow>(
        `UPDATE games SET black_id = $1, status = 'active', state = $2, version = version + 1, updated_at = now()
         WHERE id = $3 RETURNING *`,
        [me.id, JSON.stringify(state), row.id],
      );
      return { row: updated.rows[0] } as const;
    });
    if ('error' in result) {
      res.status(result.status!).json({ error: result.error });
      return;
    }
    await announce(result.row);
    res.json({ game: await view(result.row, me.id) });
  });

  router.get('/api/games/:id', async (req, res) => {
    const row = await getRow(db, req.params.id);
    if (!row || !canSee(row, req.user!.id)) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }
    res.json({ game: await view(row, req.user!.id) });
  });

  router.get('/api/games/:id/history', async (req, res) => {
    const row = await getRow(db, req.params.id);
    if (!row || !canSee(row, req.user!.id)) {
      res.status(404).json({ error: 'Game not found' });
      return;
    }
    const { rows: actions } = await db.query<{ action: unknown; at: Date; username: string }>(
      `SELECT a.action, a.created_at AS at, u.username FROM game_actions a JOIN users u ON u.id = a.user_id
       WHERE a.game_id = $1 ORDER BY a.id`,
      [row.id],
    );
    res.json({ actions: actions.map((a) => ({ ...a, at: a.at.toISOString() })) });
  });

  router.delete('/api/games/:id', async (req, res) => {
    const row = await getRow(db, req.params.id);
    if (!row || row.created_by !== req.user!.id || row.status !== 'waiting') {
      res.status(404).json({ error: 'Only an unanswered invite can be cancelled' });
      return;
    }
    await db.query(`DELETE FROM games WHERE id = $1 AND status = 'waiting'`, [row.id]);
    res.json({ ok: true });
  });

  // Every game action goes through here. The client sends the version it last
  // saw so that two tabs (or two players) can't act on a stale position.
  router.post('/api/games/:id/actions', async (req, res) => {
    const me = req.user!;
    const action = req.body?.action as Action | undefined;
    const expectedVersion = Number(req.body?.version);
    if (!action || typeof action !== 'object' || !ACTION_TYPES.has(action.type)) {
      res.status(400).json({ error: 'Unknown action' });
      return;
    }

    const outcome = await db.transaction(async (tx) => {
      // Row lock: two requests for the same game take turns.
      const row = await getRow(tx, req.params.id, true);
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
        next = applyAction(row.state, color, action, roll);
      } catch (err) {
        if (err instanceof GameError) return { status: 400, error: err.message, row } as const;
        throw err;
      }
      const finished = next.phase === 'finished';
      const winnerId = finished && next.result ? (next.result.winner === 'white' ? row.white_id : row.black_id) : null;
      const updated = await tx.query<GameRow>(
        `UPDATE games SET state = $1, version = version + 1, status = $2, winner_id = $3, points = $4, updated_at = now()
         WHERE id = $5 RETURNING *`,
        [JSON.stringify(next), finished ? 'finished' : 'active', winnerId, next.result?.points ?? null, row.id],
      );
      const logged = action.type === 'move' ? { type: 'move', moves: next.lastTurn?.moves ?? [] } : { type: action.type };
      const withDice = action.type === 'roll' ? { ...logged, dice: next.dice ?? next.lastTurn?.dice } : logged;
      await tx.query('INSERT INTO game_actions (game_id, user_id, action) VALUES ($1, $2, $3)', [
        row.id,
        me.id,
        JSON.stringify(withDice),
      ]);
      return { row: updated.rows[0] } as const;
    });

    if ('error' in outcome) {
      const body: Record<string, unknown> = { error: outcome.error };
      if ('row' in outcome && outcome.row) body.game = await view(outcome.row, me.id);
      res.status(outcome.status!).json(body);
      return;
    }
    await announce(outcome.row);
    res.json({ game: await view(outcome.row, me.id) });
  });

  return router;
}
