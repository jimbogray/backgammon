import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import express, { NextFunction, Request, Response, Router } from 'express';
import type { Config } from './config.js';
import type { Database, Queryable } from './db.js';

const OAUTH_STATE_COOKIE = 'bg_oauth_state';
const SESSION_DAYS = 30;
const LOGIN_CODE_SECONDS = 60;

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
      sessionToken?: string;
    }
  }
}

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export async function createSession(db: Queryable, userId: number): Promise<string> {
  const token = randomToken();
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [hashToken(token), userId, SESSION_DAYS],
  );
  return token;
}

function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

/**
 * Attaches `req.user` when the request carries a valid session token in an
 * `Authorization: Bearer` header. The browser app lives on a different origin
 * from the API, so tokens are used rather than cookies (Safari blocks
 * cross-site cookies).
 */
export function sessionMiddleware(db: Database) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const token = bearerToken(req);
    if (token) {
      const { rows } = await db.query<User>(
        `SELECT u.id, u.username, u.email FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now()`,
        [hashToken(token)],
      );
      if (rows[0]) {
        req.user = rows[0];
        req.sessionToken = token;
      }
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

async function usernameTaken(db: Queryable, username: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM users WHERE lower(username) = lower($1)', [username]);
  return rows.length > 0;
}

async function uniqueUsername(db: Queryable, base: string): Promise<string> {
  let clean = base.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  if (clean.length < 3) clean = `player${clean}`;
  if (!(await usernameTaken(db, clean))) return clean;
  for (;;) {
    const candidate = `${clean}${crypto.randomInt(1000, 10000)}`;
    if (!(await usernameTaken(db, candidate))) return candidate;
  }
}

export interface GoogleProfile {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/**
 * A Google sign-in whose email already belongs to a password account. Sign-up
 * doesn't verify email addresses, so that account may not be the email's owner,
 * and linking the two would let whoever registered it into the Google user's account.
 */
export class EmailInUseError extends Error {}

/** Find or create the account for a Google profile. */
export async function upsertGoogleUser(db: Database, profile: GoogleProfile): Promise<User> {
  return db.transaction(async (tx) => {
    const bySub = await tx.query<User>('SELECT id, username, email FROM users WHERE google_sub = $1', [profile.sub]);
    if (bySub.rows[0]) return bySub.rows[0];
    if (profile.email) {
      const byEmail = await tx.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [profile.email]);
      if (byEmail.rows.length) throw new EmailInUseError();
    }
    const email = profile.email && profile.email_verified ? profile.email : null;
    const username = await uniqueUsername(tx, profile.name ?? profile.email?.split('@')[0] ?? 'player');
    const { rows } = await tx.query<{ id: number }>(
      'INSERT INTO users (username, email, google_sub) VALUES ($1, $2, $3) RETURNING id',
      [username, email, profile.sub],
    );
    return { id: rows[0].id, username, email };
  });
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === '23505';
}

export interface AuthDeps {
  db: Database;
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
    if (await usernameTaken(db, username)) {
      res.status(409).json({ error: 'That username is taken' });
      return;
    }
    if ((await db.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [email])).rows.length) {
      res.status(409).json({ error: 'An account with that email already exists. Try logging in.' });
      return;
    }
    const hash = await bcrypt.hash(password, 10);
    let id: number;
    try {
      const { rows } = await db.query<{ id: number }>(
        'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [username, email, hash],
      );
      id = rows[0].id;
    } catch (err) {
      // Two sign-ups for the same name at the same moment.
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'That username or email is already taken' });
        return;
      }
      throw err;
    }
    const user: User = { id, username, email };
    res.status(201).json({ user, token: await createSession(db, id) });
  });

  router.post('/api/auth/login', async (req, res) => {
    const login = String(req.body?.login ?? '').trim();
    const password = String(req.body?.password ?? '');
    const { rows } = await db.query<User & { password_hash: string | null }>(
      `SELECT id, username, email, password_hash FROM users
       WHERE lower(email) = lower($1) OR lower(username) = lower($1)`,
      [login],
    );
    const row = rows[0];
    if (!row || !row.password_hash || !(await bcrypt.compare(password, row.password_hash))) {
      const hint = row && !row.password_hash ? ' This account uses Google sign-in.' : '';
      res.status(401).json({ error: `Incorrect username/email or password.${hint}` });
      return;
    }
    res.json({ user: { id: row.id, username: row.username, email: row.email }, token: await createSession(db, row.id) });
  });

  router.post('/api/auth/logout', async (req, res) => {
    if (req.sessionToken) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(req.sessionToken)]);
    res.json({ ok: true });
  });

  router.get('/api/me', requireUser, async (req, res) => {
    const user = req.user!;
    const { rows } = await db.query<{ wins: number; losses: number }>(
      `SELECT
         count(*) FILTER (WHERE winner_id = $1)::int AS wins,
         count(*) FILTER (WHERE winner_id IS NOT NULL AND winner_id <> $1)::int AS losses
       FROM games WHERE status = 'finished' AND (white_id = $1 OR black_id = $1)`,
      [user.id],
    );
    res.json({ user, record: { wins: rows[0].wins, losses: rows[0].losses } });
  });

  router.patch('/api/me', requireUser, async (req, res) => {
    const username = String(req.body?.username ?? '').trim();
    if (!USERNAME_RE.test(username)) {
      res.status(400).json({ error: 'Username must be 3 to 20 letters, numbers or underscores' });
      return;
    }
    const { rows } = await db.query<{ id: number }>('SELECT id FROM users WHERE lower(username) = lower($1)', [username]);
    if (rows[0] && rows[0].id !== req.user!.id) {
      res.status(409).json({ error: 'That username is taken' });
      return;
    }
    try {
      await db.query('UPDATE users SET username = $1 WHERE id = $2', [username, req.user!.id]);
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'That username is taken' });
        return;
      }
      throw err;
    }
    res.json({ user: { ...req.user!, username } });
  });

  // Google OAuth 2.0 authorization-code flow. The browser leaves the web app for
  // the API, then Google, then the API sends it back to the web app with a
  // one-time code that the app swaps for a session token.
  const redirectUri = `${config.apiUrl}/api/auth/google/callback`;
  const failed = `${config.appUrl}/?error=google`;
  const emailInUse = `${config.appUrl}/?error=google-email`;

  router.get('/api/auth/google', (req, res) => {
    if (!config.google) {
      res.status(404).send('Google sign-in is not configured');
      return;
    }
    const state = randomToken(16);
    res.cookie(OAUTH_STATE_COOKIE, JSON.stringify({ state, next: safeNext(req.query.next) }), {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: 10 * 60 * 1000,
      path: '/api/auth/google',
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

  router.get('/api/auth/google/callback', async (req, res) => {
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
    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/api/auth/google' });
    const code = req.query.code;
    if (typeof code !== 'string' || !saved.state || req.query.state !== saved.state) {
      res.redirect(failed);
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
      const user = await upsertGoogleUser(db, profile);
      const loginCode = randomToken();
      await db.query(
        `INSERT INTO login_codes (code_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`,
        [hashToken(loginCode), user.id, LOGIN_CODE_SECONDS],
      );
      // The code rides in the URL fragment, which browsers never send to a server.
      const params = new URLSearchParams({ code: loginCode, next: safeNext(saved.next) });
      res.redirect(`${config.appUrl}/auth/complete#${params}`);
    } catch (err) {
      if (err instanceof EmailInUseError) {
        res.redirect(emailInUse);
        return;
      }
      console.error('Google sign-in failed:', err);
      res.redirect(failed);
    }
  });

  router.post('/api/auth/google/exchange', async (req, res) => {
    const code = String(req.body?.code ?? '');
    const { rows } = await db.query<User>(
      `WITH used AS (
         DELETE FROM login_codes WHERE code_hash = $1 AND expires_at > now() RETURNING user_id
       )
       SELECT u.id, u.username, u.email FROM users u JOIN used ON used.user_id = u.id`,
      [hashToken(code)],
    );
    if (!rows[0]) {
      res.status(401).json({ error: 'This sign-in link has expired. Please try again.' });
      return;
    }
    res.json({ user: rows[0], token: await createSession(db, rows[0].id) });
  });

  return router;
}

/** Reject state-changing API calls that are not JSON. */
export function requireJson(req: Request, res: Response, next: NextFunction): void {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.path.startsWith('/api/') && !req.is('application/json')) {
    res.status(415).json({ error: 'Expected application/json' });
    return;
  }
  next();
}

export const jsonBody = express.json({ limit: '32kb' });
