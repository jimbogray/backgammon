import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MatchSummary } from '../../shared/api';
import type { Color } from '../../shared/engine';
import { api } from '../api';
import { useAuth } from '../auth';
import { useGameEvents } from '../events';
import { Header } from '../components/Header';
import { timeAgo } from './Lobby';

/** Every game in progress or finished, for anyone to watch. */
export function MatchesPage() {
  const { me } = useAuth();
  const [matches, setMatches] = useState<MatchSummary[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { matches } = await api.matches();
      setMatches(matches);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Any started game changing is news here; batch them into at most one refetch every 2s to stay well inside the API rate limit.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(timer.current ?? undefined), []);
  useGameEvents(() => {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void load();
    }, 2000);
  });

  const live = matches?.filter((m) => m.status === 'active') ?? [];
  const finished = matches?.filter((m) => m.status === 'finished') ?? [];

  return (
    <>
      <Header />
      <main className="page">
        <h1 className="page-title">Matches</h1>
        {error && <p className="error" role="alert">{error}</p>}
        {matches === null ? (
          !error && <p className="muted">Loading matches…</p>
        ) : matches.length === 0 ? (
          <section className="card empty">
            <h2>No matches yet</h2>
            <p className="muted">Games show up here once both players have joined.</p>
          </section>
        ) : null}
        <MatchGroup title="In progress" matches={live} myId={me?.user.id} />
        <MatchGroup title="Completed" matches={finished} myId={me?.user.id} />
      </main>
    </>
  );
}

function MatchGroup({ title, matches, myId }: { title: string; matches: MatchSummary[]; myId?: number }) {
  if (matches.length === 0) return null;
  return (
    <section>
      <h2>
        {title} <span className="count">{matches.length}</span>
      </h2>
      <ul className="game-list">
        {matches.map((m) => {
          const playing = m.players.white?.id === myId || m.players.black?.id === myId;
          return (
            <li key={m.id} className="game-row match-row">
              <div className="grow">
                <div className="match-players">
                  <PlayerName match={m} color="white" />
                  <span className="muted">vs</span>
                  <PlayerName match={m} color="black" />
                </div>
                <div className="muted small">{describe(m)}</div>
              </div>
              <Link to={`/game/${m.id}`} className={`button ${playing ? 'primary' : ''}`}>
                {playing && m.status === 'active' ? 'Play' : 'View'}
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function PlayerName({ match, color }: { match: MatchSummary; color: Color }) {
  const onTurn = match.turn === color;
  const won = match.result?.winner === color;
  return (
    <span className={`match-player ${onTurn || won ? 'strong' : ''}`}>
      <span className={`chip ${color}`} aria-hidden="true" />
      {match.players[color]?.username ?? 'unknown'}
    </span>
  );
}

function describe(m: MatchSummary): string {
  const name = (c: Color) => m.players[c]?.username ?? c;
  if (m.result) {
    const pts = `${m.result.points} point${m.result.points === 1 ? '' : 's'}`;
    const how = m.result.reason === 'resign' ? ' by resignation' : m.result.reason === 'drop' ? ' (double passed)' : '';
    return `${name(m.result.winner)} won ${pts}${how} · ${timeAgo(m.updatedAt)}`;
  }
  const parts = [m.turn ? `${name(m.turn)} to play` : null];
  if (m.pips) parts.push(`pips ${m.pips.white}–${m.pips.black}`);
  if (m.cube > 1) parts.push(`cube ${m.cube}`);
  parts.push(`last move ${timeAgo(m.updatedAt)}`);
  return parts.filter(Boolean).join(' · ');
}
