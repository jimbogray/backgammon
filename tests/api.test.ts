import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { Config } from '../src/server/config';
import { openDatabase } from '../src/server/db';
import type { GameView } from '../src/shared/api';
import { availableMoves, Roller } from '../src/shared/engine';

const baseConfig: Config = {
  port: 0,
  appUrl: 'http://localhost:5173',
  databasePath: ':memory:',
  isProduction: false,
  google: null,
};

function cycleRoller(values: number[]): Roller {
  let i = 0;
  return () => values[i++ % values.length];
}

function makeApp(opts: { config?: Partial<Config>; fetch?: typeof fetch; roll?: Roller } = {}) {
  const db = openDatabase(':memory:');
  const app = createApp({
    db,
    config: { ...baseConfig, ...opts.config },
    roll: opts.roll ?? cycleRoller([3, 1, 5, 2, 6, 4]),
    fetch: opts.fetch,
  });
  return { app, db };
}

async function signup(app: ReturnType<typeof makeApp>['app'], username: string) {
  const agent = request.agent(app);
  const res = await agent
    .post('/api/auth/signup')
    .send({ username, email: `${username}@example.com`, password: 'correct horse' });
  expect(res.status).toBe(201);
  return agent;
}

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

    const bad = await agent.post('/api/auth/login').send({ login: 'alice', password: 'nope' });
    expect(bad.status).toBe(401);
    expect((await agent.post('/api/auth/login').send({ login: 'alice@example.com', password: 'correct horse' })).status).toBe(200);
    expect((await agent.get('/api/me')).body.user.username).toBe('alice');
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
    expect((await request(app).get('/auth/google')).status).toBe(404);
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

  it('redirects to Google, then creates an account on callback', async () => {
    const { app } = makeApp({
      config: { google },
      fetch: fakeGoogle({ sub: 'g-123', email: 'carol@gmail.com', email_verified: true, name: 'Carol Smith' }),
    });
    const agent = request.agent(app);
    const start = await agent.get('/auth/google?next=/join/abc');
    expect(start.status).toBe(302);
    const location = new URL(start.headers.location);
    expect(location.host).toBe('accounts.google.com');
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:5173/auth/google/callback');
    const state = location.searchParams.get('state');

    const cb = await agent.get(`/auth/google/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);
    expect(cb.headers.location).toBe('/join/abc');
    const me = await agent.get('/api/me');
    expect(me.body.user).toMatchObject({ username: 'CarolSmith', email: 'carol@gmail.com' });
  });

  it('rejects a callback with the wrong state', async () => {
    const { app } = makeApp({ config: { google }, fetch: fakeGoogle({ sub: 'x' }) });
    const agent = request.agent(app);
    await agent.get('/auth/google');
    const cb = await agent.get('/auth/google/callback?code=abc&state=forged');
    expect(cb.headers.location).toBe('/?error=google');
    expect((await agent.get('/api/me')).status).toBe(401);
  });

  it('links Google to an existing account with the same verified email', async () => {
    const { app } = makeApp({
      config: { google },
      fetch: fakeGoogle({ sub: 'g-alice', email: 'alice@example.com', email_verified: true, name: 'Alice' }),
    });
    await signup(app, 'alice');
    const agent = request.agent(app);
    const start = await agent.get('/auth/google');
    const state = new URL(start.headers.location).searchParams.get('state');
    await agent.get(`/auth/google/callback?code=abc&state=${state}`);
    expect((await agent.get('/api/me')).body.user.username).toBe('alice');
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
