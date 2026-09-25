import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { GameView } from '../../shared/api';
import {
  Action,
  availableMoves,
  canDouble,
  Color,
  Move,
  opponent,
  pipCount,
  pipDistance,
  TurnRecord,
  turnSoFar,
} from '../../shared/engine';
import { api, ApiError, inviteUrl } from '../api';
import { Board, Motion, Spot } from '../components/Board';
import { CopyButton } from '../components/CopyButton';
import { Header } from '../components/Header';
import { useGameEvents } from '../events';

/** Standard notation for a move, e.g. "13/8" or "bar/22" or "6/off", from the mover's side. */
function notation(color: Color, m: Move): string {
  const from = m.from === 'bar' ? 'bar' : String(pipDistance(color, m.from));
  const to = m.to === 'off' ? 'off' : String(pipDistance(color, m.to));
  return `${from}/${to}`;
}

function describeTurn(turn: TurnRecord, name: string): string {
  const roll = `${turn.dice[0]}-${turn.dice[1]}`;
  if (turn.moves.length === 0) return `${name} rolled ${roll} and couldn't move.`;
  return `${name} rolled ${roll}: ${turn.moves.map((m) => notation(turn.color, m)).join(' ')}`;
}

/** How long the dice tumble when the server doesn't say (it picks about two seconds per roll). */
const ROLL_MS = 2000;

function randomFaces(): number[] {
  return [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
}

/**
 * Tumbling dice shown while a roll is under way, on the roller's screen and
 * on every other screen watching the game. The faces flicker fast at first and
 * slow down as the roll settles, for a bit of suspense.
 */
function useRollAnimation() {
  const [roll, setRoll] = useState<{ color: Color; faces: number[] } | null>(null);
  const timers = useRef<{ tick?: ReturnType<typeof setTimeout>; end?: ReturnType<typeof setTimeout> }>({});
  const run = useRef({ color: 'white' as Color, startedAt: 0, ms: ROLL_MS });

  const stop = useCallback(() => {
    clearTimeout(timers.current.tick);
    clearTimeout(timers.current.end);
    timers.current = {};
    setRoll(null);
  }, []);

  const tick = useCallback(() => {
    const { color, startedAt, ms } = run.current;
    setRoll({ color, faces: randomFaces() });
    const progress = Math.min(1, (performance.now() - startedAt) / ms);
    timers.current.tick = setTimeout(tick, 60 + 280 * progress * progress);
  }, []);

  /** Starts the roll, or when it's already going, sets how long it lasts in all (`ms` from the server). */
  const start = useCallback(
    (color: Color, ms?: number) => {
      const rolling = Boolean(timers.current.end);
      if (!rolling) {
        run.current = { color, startedAt: performance.now(), ms: ms ?? ROLL_MS };
        tick();
      } else if (ms) {
        run.current.ms = ms;
      } else {
        return;
      }
      clearTimeout(timers.current.end);
      timers.current.end = setTimeout(stop, Math.max(0, run.current.startedAt + run.current.ms - performance.now()));
    },
    [stop, tick],
  );

  useEffect(() => stop, [stop]);
  return { roll, start, stop };
}

export function GamePage() {
  const { id = '' } = useParams();
  const [game, setGame] = useState<GameView | null>(null);
  const [error, setError] = useState('');
  // A move sent to the server and shown straight away, until the reply arrives.
  const [pending, setPending] = useState<Move[]>([]);
  const [selected, setSelected] = useState<Spot | null>(null);
  const [busy, setBusy] = useState(false);
  const [motion, setMotion] = useState<Motion | null>(null);
  const { roll, start: startRoll, stop: stopRoll } = useRollAnimation();

  const versionRef = useRef<number | null>(null);
  useEffect(() => {
    versionRef.current = game?.version ?? null;
  }, [game]);

  /** Fetches the game; `moved` is a move someone else just made, to animate once the new board is in. */
  const load = useCallback(async (moved?: Motion) => {
    try {
      const { game } = await api.game(id);
      if (versionRef.current !== game.version) {
        setPending([]);
        setSelected(null);
        setMotion(moved ?? null);
      }
      setGame(game);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useGameEvents((e) => {
    if (e.kind === 'resync') {
      void load();
      return;
    }
    if (e.id !== id) return;
    const a = e.action;
    if (a?.type === 'roll') startRoll(a.by, a.rollMs);
    // This player's own moves are animated as they're made.
    const last = a?.type === 'move' && a.by !== game?.you ? a.moves?.at(-1) : undefined;
    void load(last && a ? { move: last, color: a.by, key: `r${e.version}` } : undefined);
  });

  const state = game?.state ?? null;
  const you = game?.you ?? null;
  // Spectators see the board from white's side, like a player would.
  const spectating = Boolean(game && !you);
  const seat: Color = you ?? 'white';
  const them = opponent(seat);
  const names = {
    white: game?.players.white?.username ?? 'White',
    black: game?.players.black?.username ?? 'Black',
  };

  const turnInfo = useMemo(() => {
    if (!state || !you) return null;
    try {
      return availableMoves(state, you, pending);
    } catch {
      return null;
    }
  }, [state, you, pending]);

  const legal = turnInfo?.legal ?? [];
  const myMoving = Boolean(state && you && state.phase === 'moving' && state.turn === you);
  const displayBoard = myMoving && turnInfo ? turnInfo.progress.board : state?.board;

  useEffect(() => {
    if (!state || !you) return;
    const waitingOnYou =
      state.phase !== 'finished' &&
      (state.phase === 'doubling' ? state.doubleOfferedBy !== you : state.turn === you);
    document.title = waitingOnYou ? '● Your turn · Backgammon' : 'Backgammon';
    return () => {
      document.title = 'Backgammon';
    };
  }, [state, you]);

  async function act(action: Action) {
    if (!game) return;
    setBusy(true);
    setError('');
    if (action.type === 'roll' && you) startRoll(you);
    try {
      const { game: next, rollMs } = await api.act(game.id, action, game.version);
      if (action.type === 'roll' && you && rollMs) startRoll(you, rollMs);
      setGame(next);
      setPending([]);
      // After a move, keep the checker selected if it can go on moving.
      if (action.type !== 'move' || next.state?.phase !== 'moving' || next.state.turn !== you) setSelected(null);
    } catch (err) {
      if (action.type === 'roll') stopRoll();
      setError((err as Error).message);
      if (err instanceof ApiError && err.body.game) {
        setGame(err.body.game as GameView);
        setPending([]);
        setSelected(null);
      }
    } finally {
      setBusy(false);
    }
  }

  const sources = new Set<Spot>(myMoving && !roll ? legal.map((m) => m.from) : []);
  const targets = new Set<Spot>(
    myMoving && selected !== null ? legal.filter((m) => m.from === selected).map((m) => m.to) : [],
  );

  function onSpotClick(spot: Spot) {
    if (!myMoving || busy || roll) return;
    if (selected !== null && targets.has(spot)) {
      // Prefer the smallest die that makes this move (keeps larger dice for bearing off).
      const move = legal
        .filter((m) => m.from === selected && m.to === spot)
        .sort((a, b) => a.die - b.die)[0];
      // Moves are final: show it now and save it straight away.
      const next = [...pending, move];
      setPending(next);
      setMotion({ move, color: you!, key: `l${game!.version}-${next.length}` });
      void act({ type: 'move', moves: [move] });
      // Keep the same checker selected if it can keep moving.
      try {
        const after = availableMoves(state!, you!, next);
        const landed = move.to === 'off' ? null : move.to;
        setSelected(landed !== null && after.legal.some((m) => m.from === landed) ? landed : null);
      } catch {
        setSelected(null);
      }
      return;
    }
    if (sources.has(spot)) setSelected(selected === spot ? null : spot);
    else setSelected(null);
  }

  if (error && !game) {
    return (
      <>
        <Header />
        <main className="page narrow">
          <p className="error">{error}</p>
          <Link to="/">Back to your games</Link>
        </main>
      </>
    );
  }
  if (!game) return <div className="loading">Loading game…</div>;

  if (game.status === 'waiting' || !state) {
    return (
      <>
        <Header />
        <main className="page narrow">
          <section className="card">
            <h2>Waiting for an opponent</h2>
            {game.inviteCode ? (
              <>
                <p>Send this link to the person you want to play. The game starts when they join.</p>
                <div className="invite-box">
                  <code>{inviteUrl(game.inviteCode)}</code>
                  <CopyButton text={inviteUrl(game.inviteCode)} />
                </div>
              </>
            ) : null}
            <Link to="/">Back to your games</Link>
          </section>
        </main>
      </>
    );
  }

  const lastTurnIndices = new Set<number>(
    !myMoving && state.lastTurn && (spectating || state.lastTurn.color === them)
      ? state.lastTurn.moves.flatMap((m) => [m.from, m.to].filter((s): s is number => typeof s === 'number'))
      : [],
  );

  let prompt: string;
  if (roll) {
    prompt = roll.color === you ? 'Rolling…' : `${names[roll.color]} is rolling…`;
  } else if (spectating) {
    prompt = spectatorPrompt(state, names);
  } else if (state.phase === 'finished' && state.result) {
    const r = state.result;
    const won = r.winner === you;
    const how =
      r.reason === 'resign'
        ? `${won ? names[them] : 'You'} resigned. `
        : r.reason === 'drop'
          ? `${won ? names[them] : 'You'} passed the double. `
          : r.type !== 'normal'
            ? `${r.type === 'gammon' ? 'Gammon' : 'Backgammon'}! `
            : '';
    prompt = `${how}${won ? 'You won' : `${names[r.winner]} won`} ${r.points} point${r.points === 1 ? '' : 's'}.`;
  } else if (state.phase === 'doubling') {
    prompt =
      state.doubleOfferedBy === you
        ? `You offered a double. Waiting for ${names[them]} to take or pass.`
        : `${names[them]} doubles to ${state.cube.value * 2}. Take it or pass (and lose ${state.cube.value} point${state.cube.value === 1 ? '' : 's'})?`;
  } else if (state.turn !== you) {
    prompt = state.phase === 'rolling' ? `Waiting for ${names[them]} to roll.` : `Waiting for ${names[them]} to move.`;
  } else if (state.phase === 'rolling') {
    prompt = 'Your turn. Roll the dice.';
  } else if (selected !== null) {
    prompt = 'Choose where to move the checker.';
  } else {
    prompt = state.turnNumber === 1 ? `You won the opening roll (${state.dice?.join('-')}). Pick a checker to move.` : 'Pick a checker to move.';
  }

  const lastTurnText =
    state.lastTurn && (spectating || state.lastTurn.color === them) && state.phase !== 'finished'
      ? describeTurn(state.lastTurn, names[state.lastTurn.color])
      : null;
  const backTo = spectating ? { to: '/matches', label: 'All matches' } : { to: '/', label: 'All games' };

  const board = displayBoard!;

  // Dice: tumbling during a roll, else this turn's roll, else a roll that couldn't be played.
  const unplayable = !state.dice && state.phase === 'rolling' && state.lastTurn?.moves.length === 0 ? state.lastTurn : null;
  const dice = roll ? roll.faces : (state.dice ?? unplayable?.dice ?? null);
  const diceColor = roll ? roll.color : unplayable && !state.dice ? unplayable.color : state.turn;
  const remaining = roll
    ? null
    : myMoving
      ? (turnInfo?.progress.remaining ?? null)
      : state.phase === 'moving'
        ? turnSoFar(state, state.turn).remaining
        : unplayable && !state.dice
          ? []
          : null;
  const playedThisTurn = state.phase === 'moving' ? (state.played ?? []) : [];

  return (
    <>
      <Header />
      <main className="page game-page">
        <div className="players">
          <PlayerTag name={names[them]} color={them} pips={pipCount(board, them)} active={state.phase !== 'finished' && state.turn === them} />
          <div className="players-middle">
            {spectating && <span className="badge">Watching</span>}
            <Link to={backTo.to} className="muted small">← {backTo.label}</Link>
          </div>
          <PlayerTag
            name={spectating ? names[seat] : `${names[seat]} (you)`}
            color={seat}
            pips={pipCount(board, seat)}
            active={state.phase !== 'finished' && state.turn === seat}
          />
        </div>

        <div className="board-wrap">
          <Board
            board={board}
            you={seat}
            dice={dice}
            remaining={remaining}
            diceColor={diceColor}
            rolling={Boolean(roll)}
            motion={motion}
            cube={state.cube}
            selected={selected}
            sources={sources}
            targets={targets}
            recent={lastTurnIndices}
            onSpotClick={onSpotClick}
          />
        </div>

        <div className="controls card">
          <p className="prompt" aria-live="polite">{prompt}</p>
          {lastTurnText && <p className="muted small">{lastTurnText}</p>}
          {error && <p className="error" role="alert">{error}</p>}
          {spectating ? null : (
            <div className="buttons">
              {state.phase === 'rolling' && state.turn === you && (
                <>
                  <button className="button primary" onClick={() => act({ type: 'roll' })} disabled={busy}>
                    Roll dice
                  </button>
                  {canDouble(state, seat) && (
                    <button className="button" onClick={() => act({ type: 'double' })} disabled={busy}>
                      Double to {state.cube.value * 2}
                    </button>
                  )}
                </>
              )}
              {state.phase === 'doubling' && state.doubleOfferedBy === them && (
                <>
                  <button className="button primary" onClick={() => act({ type: 'take' })} disabled={busy}>
                    Take
                  </button>
                  <button className="button" onClick={() => act({ type: 'drop' })} disabled={busy}>
                    Pass
                  </button>
                </>
              )}
              {state.phase !== 'finished' && (
                <button
                  className="button ghost danger"
                  onClick={() => {
                    if (window.confirm('Resign this game? Your opponent wins at the current stakes.')) void act({ type: 'resign' });
                  }}
                  disabled={busy}
                >
                  Resign
                </button>
              )}
              {state.phase === 'finished' && (
                <Link className="button primary" to="/">
                  Back to your games
                </Link>
              )}
            </div>
          )}
          {playedThisTurn.length > 0 && (
            <p className="muted small">
              {state.turn === you ? 'This turn' : `${names[state.turn]} this turn`}:{' '}
              {playedThisTurn.map((m) => notation(state.turn, m)).join(' ')}
            </p>
          )}
        </div>
      </main>
    </>
  );
}

/** What's happening, told from the sidelines. */
function spectatorPrompt(state: NonNullable<GameView['state']>, names: Record<Color, string>): string {
  if (state.phase === 'finished' && state.result) {
    const r = state.result;
    const loser = names[opponent(r.winner)];
    const how =
      r.reason === 'resign'
        ? `${loser} resigned. `
        : r.reason === 'drop'
          ? `${loser} passed the double. `
          : r.type !== 'normal'
            ? `${r.type === 'gammon' ? 'Gammon' : 'Backgammon'}! `
            : '';
    return `${how}${names[r.winner]} won ${r.points} point${r.points === 1 ? '' : 's'}.`;
  }
  if (state.phase === 'doubling' && state.doubleOfferedBy) {
    const offeredTo = opponent(state.doubleOfferedBy);
    return `${names[state.doubleOfferedBy]} doubles to ${state.cube.value * 2}. Waiting for ${names[offeredTo]} to take or pass.`;
  }
  return state.phase === 'rolling' ? `${names[state.turn]} to roll.` : `${names[state.turn]} to move.`;
}

function PlayerTag({ name, color, pips, active }: { name: string; color: Color; pips: number; active: boolean }) {
  return (
    <div className={`player-tag ${active ? 'active' : ''}`}>
      <span className={`chip ${color}`} aria-hidden="true" />
      <span className="name">{name}</span>
      <span className="muted small">{pips} pips</span>
    </div>
  );
}
