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
} from '../../shared/engine';
import { api, ApiError, inviteUrl } from '../api';
import { Board, Spot } from '../components/Board';
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

export function GamePage() {
  const { id = '' } = useParams();
  const [game, setGame] = useState<GameView | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Move[]>([]);
  const [selected, setSelected] = useState<Spot | null>(null);
  const [busy, setBusy] = useState(false);

  const versionRef = useRef<number | null>(null);
  useEffect(() => {
    versionRef.current = game?.version ?? null;
  }, [game]);

  const load = useCallback(async () => {
    try {
      const { game } = await api.game(id);
      // Only drop a half-built turn if the game actually changed underneath it.
      if (versionRef.current !== game.version) {
        setPending([]);
        setSelected(null);
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
    if (e.id === id || e.id === '*') void load();
  });

  const state = game?.state ?? null;
  const you = game?.you ?? null;
  const them = you ? opponent(you) : null;
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
  const turnComplete = myMoving && legal.length === 0;

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
    try {
      const { game: next } = await api.act(game.id, action, game.version);
      setGame(next);
      setPending([]);
      setSelected(null);
    } catch (err) {
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

  const sources = new Set<Spot>(myMoving ? legal.map((m) => m.from) : []);
  const targets = new Set<Spot>(
    myMoving && selected !== null ? legal.filter((m) => m.from === selected).map((m) => m.to) : [],
  );

  function onSpotClick(spot: Spot) {
    if (!myMoving || busy) return;
    if (selected !== null && targets.has(spot)) {
      // Prefer the smallest die that makes this move (keeps larger dice for bearing off).
      const move = legal
        .filter((m) => m.from === selected && m.to === spot)
        .sort((a, b) => a.die - b.die)[0];
      const next = [...pending, move];
      setPending(next);
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

  if (game.status === 'waiting' || !state || !you || !them) {
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
    !myMoving && state.lastTurn && state.lastTurn.color === them
      ? state.lastTurn.moves.flatMap((m) => [m.from, m.to].filter((s): s is number => typeof s === 'number'))
      : [],
  );

  let prompt: string;
  if (state.phase === 'finished' && state.result) {
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
  } else if (turnComplete) {
    prompt = 'Done moving. Confirm your turn or undo.';
  } else if (selected !== null) {
    prompt = 'Choose where to move the checker.';
  } else {
    prompt = state.turnNumber === 1 ? `You won the opening roll (${state.dice?.join('-')}). Pick a checker to move.` : 'Pick a checker to move.';
  }

  const lastTurnText =
    state.lastTurn && state.lastTurn.color === them && state.phase !== 'finished'
      ? describeTurn(state.lastTurn, names[them])
      : null;

  const board = displayBoard!;

  return (
    <>
      <Header />
      <main className="page game-page">
        <div className="players">
          <PlayerTag name={names[them]} color={them} pips={pipCount(board, them)} active={state.phase !== 'finished' && state.turn === them} />
          <Link to="/" className="muted small">← All games</Link>
          <PlayerTag name={`${names[you]} (you)`} color={you} pips={pipCount(board, you)} active={state.phase !== 'finished' && state.turn === you} />
        </div>

        <div className="board-wrap">
          <Board
            board={board}
            you={you}
            dice={state.dice}
            remaining={myMoving ? (turnInfo?.progress.remaining ?? null) : null}
            diceColor={state.turn}
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
          <div className="buttons">
            {state.phase === 'rolling' && state.turn === you && (
              <>
                <button className="button primary" onClick={() => act({ type: 'roll' })} disabled={busy}>
                  Roll dice
                </button>
                {canDouble(state, you) && (
                  <button className="button" onClick={() => act({ type: 'double' })} disabled={busy}>
                    Double to {state.cube.value * 2}
                  </button>
                )}
              </>
            )}
            {myMoving && (
              <>
                <button
                  className="button primary"
                  onClick={() => act({ type: 'move', moves: pending })}
                  disabled={busy || !turnComplete}
                >
                  Confirm move
                </button>
                <button
                  className="button"
                  onClick={() => {
                    setPending(pending.slice(0, -1));
                    setSelected(null);
                  }}
                  disabled={busy || pending.length === 0}
                >
                  Undo
                </button>
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
          {myMoving && pending.length > 0 && (
            <p className="muted small">This turn: {pending.map((m) => notation(you, m)).join(' ')}</p>
          )}
        </div>
      </main>
    </>
  );
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
