import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { Config } from '../src/server/config';
import { EventHub } from '../src/server/events';
import type { GameView } from '../src/shared/api';
import { availableMoves, Roller } from '../src/shared/engine';
import { createTestDatabase } from './testDb';

const baseConfig: Config = {
  port: 0,
  appUrl: 'http://localhost:5173',
  apiUrl: 'http://localhost:5173',
  corsOrigins: ['http://localhost:5173'],
  databaseUrl: 'unused',
  databaseAuth: 'password',
  isProduction: false,
  google: null,
};

function cycleRoller(values: number[]): Roller {
  let i = 0;
  return () => values[i++ % values.length];
}

let db: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.reset();
});

function makeApp(opts: { config?: Partial<Config>; fetch?: typeof fetch; roll?: Roller; hub?: EventHub } = {}) {
  const app = createApp({
    db,
    config: { ...baseConfig, ...opts.config },
    roll: opts.roll ?? cycleRoller([3, 1, 5, 2, 6, 4]),
    fetch: opts.fetch,
    hub: opts.hub,
  });
  return { app, db };
}

type App = ReturnType<typeof makeApp>['app'];

/** A client that sends the given session token on every request, like the browser app does. */
function withToken(app: App, token: string) {
  return request.agent(app).set('Authorization', `Bearer ${token}`);
}

async function signup(app: App, username: string) {
  const res = await request(app)
    .post('/api/auth/signup')
    .send({ username, email: `${username}@example.com`, password: 'correct horse' });
  expect(res.status).toBe(201);
  expect(typeof res.body.token).toBe('string');
  return withToken(app, res.body.token);
}

describe('health check', () => {
  it('reports the running build', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, version: process.env.APP_VERSION ?? 'dev' });
  });
});

describe('accounts', () => {
  let app: ReturnType<typeof makeApp>['app'];
  beforeEach(() => {
    app = makeApp().app;
  });

  it('requires login for the API', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
  });

  it('signs up, logs out, and logs back in by email or username', async () => {
    const agent = await signup(app, 'alice');
    expect((await agent.get('/api/me')).body.user.username).toBe('alice');
    await agent.post('/api/auth/logout').send({});
    expect((await agent.get('/api/me')).status).toBe(401);

    const bad = await request(app).post('/api/auth/login').send({ login: 'alice', password: 'nope' });
    expect(bad.status).toBe(401);
    const good = await request(app).post('/api/auth/login').send({ login: 'ALICE@example.com', password: 'correct horse' });
    expect(good.status).toBe(200);
    expect((await withToken(app, good.body.token).get('/api/me')).body.user.username).toBe('alice');
  });

  it('ignores unknown tokens', async () => {
    expect((await withToken(app, 'forged').get('/api/me')).status).toBe(401);
  });

  it('allows the web app origin through CORS and no other', async () => {
    const preflight = await request(app)
      .options('/api/games')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization, content-type');
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(preflight.headers['access-control-allow-headers']).toMatch(/Authorization/);

    const other = await request(app).get('/api/auth/providers').set('Origin', 'https://evil.example');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects duplicate usernames and weak passwords', async () => {
    await signup(app, 'alice');
    const dup = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'ALICE', email: 'other@example.com', password: 'correct horse' });
    expect(dup.status).toBe(409);
    const weak = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'bob', email: 'bob@example.com', password: 'short' });
    expect(weak.status).toBe(400);
  });

  it('rejects non-JSON form posts', async () => {
    const res = await request(app).post('/api/auth/login').type('form').send('login=a&password=b');
    expect(res.status).toBe(415);
  });

  it('answers malformed JSON with 400', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{oops');
    expect(res.status).toBe(400);
  });

  it('reports Google as disabled without credentials', async () => {
    expect((await request(app).get('/api/auth/providers')).body).toEqual({ google: false });
    expect((await request(app).get('/api/auth/google')).status).toBe(404);
  });
});

describe('Google sign-in', () => {
  const google = { clientId: 'client-id', clientSecret: 'client-secret' };

  function fakeGoogle(profile: object): typeof fetch {
    return (async (url: string | URL) => {
      const u = String(url);
      if (u.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 });
      }
      if (u.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
        return new Response(JSON.stringify(profile), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
  }

  /** Follows the browser through /api/auth/google and back, returning where the API sent it. */
  async function googleRoundTrip(app: App, next = '/') {
    const browser = request.agent(app);
    const start = await browser.get(`/api/auth/google?next=${encodeURIComponent(next)}`);
    expect(start.status).toBe(302);
    const google = new URL(start.headers.location);
    const cb = await browser.get(`/api/auth/google/callback?code=abc&state=${google.searchParams.get('state')}`);
    expect(cb.status).toBe(302);
    return { google, back: new URL(cb.headers.location) };
  }

  async function exchange(app: App, back: URL) {
    const code = new URLSearchParams(back.hash.slice(1)).get('code');
    return request(app).post('/api/auth/google/exchange').send({ code });
  }

  it('redirects to Google, then hands the web app a one-time code for a session', async () => {
    const { app } = makeApp({
      config: { google, apiUrl: 'https://api.example.com', appUrl: 'https://app.example.com' },
      fetch: fakeGoogle({ sub: 'g-123', email: 'carol@gmail.com', email_verified: true, name: 'Carol Smith' }),
    });
    const { google: to, back } = await googleRoundTrip(app, '/join/abc');
    expect(to.host).toBe('accounts.google.com');
    expect(to.searchParams.get('redirect_uri')).toBe('https://api.example.com/api/auth/google/callback');

    expect(back.origin + back.pathname).toBe('https://app.example.com/auth/complete');
    expect(back.search).toBe('');
    expect(new URLSearchParams(back.hash.slice(1)).get('next')).toBe('/join/abc');

    const swapped = await exchange(app, back);
    expect(swapped.status).toBe(200);
    expect(swapped.body.user).toMatchObject({ username: 'CarolSmith', email: 'carol@gmail.com' });
    const me = await withToken(app, swapped.body.token).get('/api/me');
    expect(me.body.user.username).toBe('CarolSmith');

    // The code works once.
    expect((await exchange(app, back)).status).toBe(401);
  });

  it('rejects a callback with the wrong state', async () => {
    const { app } = makeApp({ config: { google }, fetch: fakeGoogle({ sub: 'x' }) });
    const browser = request.agent(app);
    await browser.get('/api/auth/google');
    const cb = await browser.get('/api/auth/google/callback?code=abc&state=forged');
    expect(cb.headers.location).toBe('http://localhost:5173/?error=google');
  });

  it('links Google to an existing account with the same verified email', async () => {
    const { app } = makeApp({
      config: { google },
      fetch: fakeGoogle({ sub: 'g-alice', email: 'alice@example.com', email_verified: true, name: 'Alice' }),
    });
    await signup(app, 'alice');
    const { back } = await googleRoundTrip(app);
    expect((await exchange(app, back)).body.user.username).toBe('alice');
  });
});

describe('games', () => {
  it('plays a game between two players on separate sessions', async () => {
    const { app } = makeApp();
    const alice = await signup(app, 'alice');
    const bob = await signup(app, 'bob');

    const created = await alice.post('/api/games').send({ opponent: 'bob' });
    expect(created.status).toBe(201);
    let game: GameView = created.body.game;
    expect(game.status).toBe('active');
    // Opening roll 3 (white) vs 1 (black): white (alice) moves first with 3-1.
    expect(game.state?.turn).toBe('white');
    expect(game.state?.dice).toEqual([3, 1]);

    // Bob can't move out of turn.
    const early = await bob.post(`/api/games/${game.id}/actions`).send({ action: { type: 'roll' }, version: game.version });
    expect(early.status).toBe(400);

    // Both players see the game in their lobby, and it's alice's turn.
    const aliceList = (await alice.get('/api/games')).body.games;
    const bobList = (await bob.get('/api/games')).body.games;
    expect(aliceList[0]).toMatchObject({ id: game.id, yourTurn: true, opponent: { username: 'bob' } });
    expect(bobList[0]).toMatchObject({ id: game.id, yourTurn: false, opponent: { username: 'alice' } });

    // Alice makes the 8/5 6/5 point.
    const moved = await alice.post(`/api/games/${game.id}/actions`).send({
      action: { type: 'move', moves: [{ from: 7, to: 4, die: 3 }, { from: 5, to: 4, die: 1 }] },
      version: game.version,
    });
    expect(moved.status).toBe(200);
    game = moved.body.game;
    expect(game.state?.turn).toBe('black');
    expect(game.state?.phase).toBe('rolling');

    // A stale version is rejected with the latest game attached.
    const stale = await bob.post(`/api/games/${game.id}/actions`).send({ action: { type: 'roll' }, version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.game.version).toBe(game.version);

    // Bob rolls and plays the first legal sequence.
    const rolled = await bob.post(`/api/games/${game.id}/actions`).send({ action: { type: 'roll' }, version: game.version });
    game = rolled.body.game;
    expect(game.state?.phase).toBe('moving');
    const played = [];
    for (;;) {
      const { legal } = availableMoves(game.state!, 'black', played);
      if (legal.length === 0) break;
      played.push(legal[0]);
    }
    const bobMoved = await bob
      .post(`/api/games/${game.id}/actions`)
      .send({ action: { type: 'move', moves: played }, version: game.version });
    expect(bobMoved.status).toBe(200);
    expect(bobMoved.body.game.state.turn).toBe('white');

    // The game is saved and shows up with full history.
    const reloaded = await alice.get(`/api/games/${game.id}`);
    expect(reloaded.body.game.version).toBe(bobMoved.body.game.version);
    const history = await alice.get(`/api/games/${game.id}/history`);
    expect(history.body.actions.map((a: { action: { type: string } }) => a.action.type)).toEqual(['move', 'roll', 'move']);
  });

  it('lists the other players to challenge, by username only', async () => {
    const { app } = makeApp();
    const carol = await signup(app, 'carol');
    await signup(app, 'Bob');
    await signup(app, 'alice');
    const res = await carol.get('/api/players');
    expect(res.status).toBe(200);
    expect(res.body.players.map((p: { username: string }) => p.username)).toEqual(['alice', 'Bob']);
    expect(Object.keys(res.body.players[0]).sort()).toEqual(['id', 'username']);
    expect((await request(app).get('/api/players')).status).toBe(401);
  });

  it('hides games from players who are not in them', async () => {
    const { app } = makeApp();
    const alice = await signup(app, 'alice');
    await signup(app, 'bob');
    const eve = await signup(app, 'eve');
    const { body } = await alice.post('/api/games').send({ opponent: 'bob' });
    expect((await eve.get(`/api/games/${body.game.id}`)).status).toBe(404);
    expect(
      (await eve.post(`/api/games/${body.game.id}/actions`).send({ action: { type: 'resign' } })).status,
    ).toBe(404);
  });

  it('starts a game from an invite link', async () => {
    const { app } = makeApp();
    const alice = await signup(app, 'alice');
    const dave = await signup(app, 'dave');
    const eve = await signup(app, 'eve');
    const { body } = await alice.post('/api/games').send({});
    expect(body.game.status).toBe('waiting');
    const code = body.game.inviteCode;
    expect(code).toBeTruthy();

    expect((await alice.post(`/api/invites/${code}/join`).send({})).status).toBe(400);
    expect((await dave.get(`/api/invites/${code}`)).body.from.username).toBe('alice');
    const joined = await dave.post(`/api/invites/${code}/join`).send({});
    expect(joined.status).toBe(200);
    expect(joined.body.game.status).toBe('active');
    expect(joined.body.game.you).toBe('black');
    expect((await eve.post(`/api/invites/${code}/join`).send({})).status).toBe(409);
  });

  it('lets a player be in several games at once and records results', async () => {
    const { app } = makeApp();
    const alice = await signup(app, 'alice');
    const bob = await signup(app, 'bob');
    await signup(app, 'carol');
    const g1 = (await alice.post('/api/games').send({ opponent: 'bob' })).body.game;
    await alice.post('/api/games').send({ opponent: 'carol' });
    expect((await alice.get('/api/games')).body.games).toHaveLength(2);

    const resigned = await bob.post(`/api/games/${g1.id}/actions`).send({ action: { type: 'resign' } });
    expect(resigned.body.game.status).toBe('finished');
    expect(resigned.body.game.state.result.winner).toBe('white');
    expect((await alice.get('/api/me')).body.record).toEqual({ wins: 1, losses: 0 });
    expect((await bob.get('/api/me')).body.record).toEqual({ wins: 0, losses: 1 });
  });
});

describe('live updates', () => {
  it('reach a browser connected to another server through Postgres NOTIFY', async () => {
    // Two hubs share one database, like two API replicas.
    const publish = async (message: string) => {
      await db.query('SELECT pg_notify($1, $2)', ['game_events_test', message]);
    };
    const hubA = new EventHub(publish);
    const hubB = new EventHub(publish);
    await db.listen('game_events_test', { onMessage: hubA.receive });
    await db.listen('game_events_test', { onMessage: hubB.receive });

    const { app } = makeApp({ hub: hubA });
    const alice = await signup(app, 'alice');
    const bob = await signup(app, 'bob');
    const bobId = (await bob.get('/api/me')).body.user.id;

    const written: string[] = [];
    hubB.add(bobId, { write: (chunk: string) => written.push(chunk) } as never);

    const { body } = await alice.post('/api/games').send({ opponent: 'bob' });
    await expect.poll(() => written.join('')).toContain(`"id":"${body.game.id}"`);
    expect(written[0]).toMatch(/^event: game\n/);
  });
});
