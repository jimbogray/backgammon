import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

/** Google sign-in lands here with a one-time code in the URL fragment. */
export function GoogleComplete() {
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const params = new URLSearchParams(window.location.hash.slice(1));
    const code = params.get('code') ?? '';
    const next = params.get('next') ?? '/';
    // Drop the code from the address bar and history.
    window.history.replaceState(null, '', window.location.pathname);
    api
      .finishGoogleSignIn(code)
      .then(() => refresh())
      .then(
        () => navigate(next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true }),
        () => navigate('/?error=google', { replace: true }),
      );
  }, [navigate, refresh]);

  return <div className="loading">Signing you in…</div>;
}
