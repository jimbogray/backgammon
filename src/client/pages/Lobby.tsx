import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { GameSummary } from '../../shared/api';
import { api, inviteUrl } from '../api';
import { useAuth } from '../auth';
import { useGameEvents } from '../events';
import { Header } from '../components/Header';
import { CopyButton } from '../components/CopyButton';

function timeAgo(sqlTime: string): string {
  const then = new Date(sqlTime.replace(' ', 'T') + 'Z').getTime();
  const s = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function Lobby() {
  const { me, refresh } = useAuth();
  const navigate = useNavigate();
  const [games, setGames] = useState<GameSummary[] | null>(null);
  const [opponent, setOpponent] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { games } = await api.games();
    setGames(games);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useGameEvents(() => {
    void load();
    void refresh();
  });

  const yourTurn = games?.filter((g) => g.status === 'active' && g.yourTurn) ?? [];
  const theirTurn = games?.filter((g) => g.status === 'active' && !g.yourTurn) ?? [];
  const invites = games?.filter((g) => g.status === 'waiting') ?? [];
  const finished = games?.filter((g) => g.status === 'finished') ?? [];

  useEffect(() => {
    document.title = yourTurn.length ? `(${yourTurn.length}) Backgammon` : 'Backgammon';
  }, [yourTurn.length]);

  async function challenge(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { game } = await api.challenge(opponent.trim());
      navigate(`/game/${game.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createInvite() {
    setBusy(true);
    setError('');
    try {
      await api.createInvite();
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancelInvite(id: string) {
    await api.cancelInvite(id);
    await load();
  }

  return (
    <>
      <Header />
      <main className="page">
        <section className="card new-game">
          <h2>New game</h2>
          <form onSubmit={challenge} className="inline-form">
            <input
              placeholder="Opponent's username"
              value={opponent}
              onChange={(e) => setOpponent(e.target.value)}
              aria-label="Opponent's username"
            />
            <button className="button primary" type="submit" disabled={busy || !opponent.trim()}>
              Challenge
            </button>
          </form>
          <p className="muted">
            Friend not signed up yet?{' '}
            <button className="link" onClick={createInvite} disabled={busy}>
              Create an invite link
            </button>{' '}
            and send it to them.
          </p>
          {error && <p className="error" role="alert">{error}</p>}
        </section>

        {games === null ? (
          <p className="muted">Loading your games…</p>
        ) : games.length === 0 ? (
          <section className="card empty">
            <h2>No games yet</h2>
            <p className="muted">Challenge someone by username, or create an invite link to get started.</p>
          </section>
        ) : null}

        {invites.length > 0 && (
          <section>
            <h2>Waiting for someone to join</h2>
            <ul className="game-list">
              {invites.map((g) => (
                <li key={g.id} className="game-row">
                  <div className="grow">
                    <div className="invite-url">{inviteUrl(g.inviteCode!)}</div>
                    <div className="muted small">Created {timeAgo(g.updatedAt)}</div>
                  </div>
                  <CopyButton text={inviteUrl(g.inviteCode!)} />
                  <button className="button ghost" onClick={() => cancelInvite(g.id)}>
                    Cancel
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <GameGroup title="Your turn" games={yourTurn} highlight />
        <GameGroup title="Waiting for opponent" games={theirTurn} />
        <GameGroup title="Finished" games={finished} />

        {me && (
          <p className="muted small record">
            Your record: {me.record.wins} won, {me.record.losses} lost
          </p>
        )}
      </main>
    </>
  );
}

function GameGroup({ title, games, highlight }: { title: string; games: GameSummary[]; highlight?: boolean }) {
  if (games.length === 0) return null;
  return (
    <section>
      <h2>
        {title} <span className="count">{games.length}</span>
      </h2>
      <ul className="game-list">
        {games.map((g) => (
          <li key={g.id}>
            <Link to={`/game/${g.id}`} className={`game-row ${highlight ? 'highlight' : ''}`}>
              <span className={`chip ${g.you}`} aria-hidden="true" />
              <div className="grow">
                <div>vs {g.opponent?.username ?? 'unknown'}</div>
                <div className="muted small">
                  {g.result
                    ? `${g.result.won ? 'You won' : 'You lost'} ${g.result.points} point${g.result.points === 1 ? '' : 's'}${
                        g.result.reason === 'resign' ? ' by resignation' : g.result.reason === 'drop' ? ' (double passed)' : ''
                      }`
                    : `Last move ${timeAgo(g.updatedAt)}`}
                </div>
              </div>
              <span className="go">{highlight ? 'Play' : 'View'} →</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
