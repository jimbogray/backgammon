import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import express, { NextFunction, Request, Response, Router } from 'express';
import type { Config } from './config.js';
import type { DB } from './db.js';

export const SESSION_COOKIE = 'bg_session';
const OAUTH_STATE_COOKIE = 'bg_oauth_state';
const SESSION_DAYS = 30;

export interface User {
  id: number;
  username: string;
  email: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(db: DB, userId: number): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    userId,
    expires,
  );
  return token;
}

function setSessionCookie(res: Response, config: Config, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

/** Attaches `req.user` when the request carries a valid session cookie. */
export function sessionMiddleware(db: DB) {
  const find = db.prepare(
    `SELECT u.id, u.username, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  );
  return (req: Request, _res: Response, next: NextFunction) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string' && token) {
      const user = find.get(hashToken(token), Date.now()) as User | undefined;
      if (user) req.user = user;
    }
    next();
  };
}

export function requireUser(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'Please log in' });
    return;
  }
  next();
}

/** Only allow a same-site relative path as a post-login redirect. */
function safeNext(value: unknown): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

function uniqueUsername(db: DB, base: string): string {
  let clean = base.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  if (clean.length < 3) clean = `player${clean}`;
  const taken = db.prepare('SELECT 1 FROM users WHERE username = ?');
  if (!taken.get(clean)) return clean;
  for (;;) {
    const candidate = `${clean}${crypto.randomInt(1000, 10000)}`;
    if (!taken.get(candidate)) return candidate;
  }
}

export interface GoogleProfile {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/** Find or create the account for a Google profile, linking by verified email. */
export function upsertGoogleUser(db: DB, profile: GoogleProfile): User {
  const bySub = db.prepare('SELECT id, username, email FROM users WHERE google_sub = ?').get(profile.sub) as
    | User
    | undefined;
  if (bySub) return bySub;
  if (profile.email && profile.email_verified) {
    const byEmail = db.prepare('SELECT id, username, email FROM users WHERE email = ?').get(profile.email) as
      | User
      | undefined;
    if (byEmail) {
      db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(profile.sub, byEmail.id);
      return byEmail;
    }
  }
  const email = profile.email && profile.email_verified ? profile.email : null;
  const username = uniqueUsername(db, profile.name ?? profile.email?.split('@')[0] ?? 'player');
  const info = db.prepare('INSERT INTO users (username, email, google_sub) VALUES (?, ?, ?)').run(
    username,
    email,
    profile.sub,
  );
  return { id: Number(info.lastInsertRowid), username, email };
}

export interface AuthDeps {
  db: DB;
  config: Config;
  fetch?: typeof fetch;
}

export function authRouter({ db, config, fetch: fetchImpl = fetch }: AuthDeps): Router {
  const router = Router();

  router.get('/api/auth/providers', (_req, res) => {
    res.json({ google: Boolean(config.google) });
  });

  router.post('/api/auth/signup', async (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    const email = String(req.body?.email ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!USERNAME_RE.test(username)) {
      res.status(400).json({ error: 'Username must be 3 to 20 letters, numbers or underscores' });
      return;
    }
    if (!EMAIL_RE.test(email)) {
      res.status(400).json({ error: 'Please enter a valid email address' });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      res.status(409).json({ error: 'That username is taken' });
      return;
    }
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      res.status(409).json({ error: 'An account with that email already exists. Try logging in.' });
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    const info = db
      .prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)')
      .run(username, email, hash);
    const user: User = { id: Number(info.lastInsertRowid), username, email };
    setSessionCookie(res, config, createSession(db, user.id));
    res.status(201).json({ user });
  });

  router.post('/api/auth/login', async (req, res) => {
    const login = String(req.body?.login ?? '').trim();
    const password = String(req.body?.password ?? '');
    const row = db
      .prepare('SELECT id, username, email, password_hash FROM users WHERE email = ? OR username = ?')
      .get(login, login) as (User & { password_hash: string | null }) | undefined;
    if (!row || !row.password_hash || !(await bcrypt.compare(password, row.password_hash))) {
      const hint = row && !row.password_hash ? ' This account uses Google sign-in.' : '';
      res.status(401).json({ error: `Incorrect username/email or password.${hint}` });
      return;
    }
    setSessionCookie(res, config, createSession(db, row.id));
    res.json({ user: { id: row.id, username: row.username, email: row.email } });
  });

  router.post('/api/auth/logout', (req, res) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (typeof token === 'string') db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/api/me', requireUser, (req, res) => {
    const user = req.user!;
    const record = db
      .prepare(
        `SELECT
           SUM(CASE WHEN winner_id = @id THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN winner_id IS NOT NULL AND winner_id != @id THEN 1 ELSE 0 END) AS losses
         FROM games WHERE status = 'finished' AND (white_id = @id OR black_id = @id)`,
      )
      .get({ id: user.id }) as { wins: number | null; losses: number | null };
    res.json({ user, record: { wins: record.wins ?? 0, losses: record.losses ?? 0 } });
  });

  router.patch('/api/me', requireUser, (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    if (!USERNAME_RE.test(username)) {
      res.status(400).json({ error: 'Username must be 3 to 20 letters, numbers or underscores' });
      return;
    }
    const taken = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number } | undefined;
    if (taken && taken.id !== req.user!.id) {
      res.status(409).json({ error: 'That username is taken' });
      return;
    }
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, req.user!.id);
    res.json({ user: { ...req.user!, username } });
  });

  // Google OAuth 2.0 authorization-code flow.
  const redirectUri = `${config.appUrl}/auth/google/callback`;

  router.get('/auth/google', (req, res) => {
    if (!config.google) {
      res.status(404).send('Google sign-in is not configured');
      return;
    }
    const state = crypto.randomBytes(16).toString('base64url');
    res.cookie(OAUTH_STATE_COOKIE, JSON.stringify({ state, next: safeNext(req.query.next) }), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 10 * 60 * 1000,
      path: '/auth/google',
    });
    const params = new URLSearchParams({
      client_id: config.google.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      prompt: 'select_account',
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  router.get('/auth/google/callback', async (req, res) => {
    if (!config.google) {
      res.status(404).send('Google sign-in is not configured');
      return;
    }
    let saved: { state?: string; next?: string } = {};
    try {
      saved = JSON.parse(req.cookies?.[OAUTH_STATE_COOKIE] ?? '{}');
    } catch {
      // fall through to the state check
    }
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth/google' });
    const code = req.query.code;
    if (typeof code !== 'string' || !saved.state || req.query.state !== saved.state) {
      res.redirect('/?error=google');
      return;
    }
    try {
      const tokenRes = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: config.google.clientId,
          client_secret: config.google.clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
      const tokens = (await tokenRes.json()) as { access_token?: string };
      const profileRes = await fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!profileRes.ok) throw new Error(`userinfo failed: ${profileRes.status}`);
      const profile = (await profileRes.json()) as GoogleProfile;
      if (!profile.sub) throw new Error('userinfo missing sub');
      const user = upsertGoogleUser(db, profile);
      setSessionCookie(res, config, createSession(db, user.id));
      res.redirect(safeNext(saved.next));
    } catch (err) {
      console.error('Google sign-in failed:', err);
      res.redirect('/?error=google');
    }
  });

  return router;
}

/** Reject state-changing API calls that are not JSON, which blocks cross-site form posts. */
export function requireJson(req: Request, res: Response, next: NextFunction): void {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.path.startsWith('/api/') && !req.is('application/json')) {
    res.status(415).json({ error: 'Expected application/json' });
    return;
  }
  next();
}

export const jsonBody = express.json({ limit: '32kb' });
