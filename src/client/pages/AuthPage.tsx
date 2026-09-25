import { FormEvent, useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, googleSignInUrl } from '../api';
import { useAuth } from '../auth';

const GOOGLE_ERRORS: Record<string, string> = {
  google: 'Google sign-in did not complete. Please try again.',
  'google-email': 'An account with this email already exists. Please log in with your password.',
};

export function AuthPage() {
  const { refresh } = useAuth();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const [mode, setMode] = useState<'login' | 'signup'>(location.pathname.startsWith('/join/') ? 'signup' : 'login');
  const [google, setGoogle] = useState(false);
  const [error, setError] = useState(GOOGLE_ERRORS[params.get('error') ?? ''] ?? '');
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    api.providers().then((p) => setGoogle(p.google), () => setGoogle(false));
  }, []);

  const next = location.pathname + location.search;
  const invited = location.pathname.startsWith('/join/');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'signup') await api.signup(username, email, password);
      else await api.login(login, password);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <section className="auth-hero">
        <h1>Backgammon</h1>
        <p>Play friends on any device. Move when you like: your games are saved, so pick up where you left off.</p>
        {invited && <p className="notice">You've been invited to a game. Sign up or log in to join.</p>}
      </section>

      <section className="card auth-card">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Log in
          </button>
          <button role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'active' : ''} onClick={() => setMode('signup')}>
            Sign up
          </button>
        </div>

        {google && (
          <>
            <a className="button google" href={googleSignInUrl(next)}>
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
                <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
                <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
                <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
              </svg>
              Continue with Google
            </a>
            <div className="divider"><span>or</span></div>
          </>
        )}

        <form onSubmit={submit}>
          {mode === 'signup' ? (
            <>
              <label>
                Username
                <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required minLength={3} maxLength={20} pattern="[A-Za-z0-9_]+" title="Letters, numbers and underscores" />
              </label>
              <label>
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
              </label>
            </>
          ) : (
            <label>
              Username or email
              <input value={login} onChange={(e) => setLogin(e.target.value)} autoComplete="username" required />
            </label>
          )}
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={mode === 'signup' ? 8 : undefined} />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="button primary" type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Log in'}
          </button>
        </form>
      </section>
    </main>
  );
}
