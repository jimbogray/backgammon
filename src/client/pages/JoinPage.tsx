import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Header } from '../components/Header';

export function JoinPage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const [invite, setInvite] = useState<Awaited<ReturnType<typeof api.invite>> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.invite(code).then(
      (inv) => {
        if (inv.joined && inv.status !== 'waiting') navigate(`/game/${inv.gameId}`, { replace: true });
        else setInvite(inv);
      },
      (err) => setError((err as Error).message),
    );
  }, [code, navigate]);

  async function join() {
    setBusy(true);
    try {
      const { game } = await api.joinInvite(code);
      navigate(`/game/${game.id}`, { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <Header />
      <main className="page narrow">
        <section className="card">
          {error ? (
            <>
              <h2>Can't join this game</h2>
              <p className="error">{error}</p>
              <Link to="/">Back to your games</Link>
            </>
          ) : !invite ? (
            <p className="muted">Loading invite…</p>
          ) : invite.joined ? (
            <>
              <h2>This is your invite</h2>
              <p>Send this page's link to a friend. The game starts as soon as they join.</p>
              <Link to="/">Back to your games</Link>
            </>
          ) : invite.status !== 'waiting' ? (
            <>
              <h2>This game already started</h2>
              <p className="muted">Someone else joined {invite.from.username}'s game first.</p>
              <Link to="/">Back to your games</Link>
            </>
          ) : (
            <>
              <h2>{invite.from.username} invited you to play</h2>
              <p className="muted">You can play now or come back any time; the game is saved between turns.</p>
              <button className="button primary" onClick={join} disabled={busy}>
                {busy ? 'Joining…' : 'Accept and play'}
              </button>
            </>
          )}
        </section>
      </main>
    </>
  );
}
