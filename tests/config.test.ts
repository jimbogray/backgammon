import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/server/config';

describe('loadConfig', () => {
  it('has working development defaults', () => {
    const config = loadConfig({});
    expect(config.appUrl).toBe('http://localhost:5173');
    expect(config.apiUrl).toBe('http://localhost:5173');
    expect(config.corsOrigins).toEqual(['http://localhost:5173']);
    expect(config.databaseUrl).toMatch(/^postgres:\/\/.*localhost/);
    expect(config.databaseAuth).toBe('password');
  });

  it('reads separate web app and API addresses for production', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      APP_URL: 'https://app.example.com/',
      API_URL: 'https://api.example.com',
      DATABASE_URL: 'postgres://me@db.example.com/backgammon',
      DATABASE_AUTH: 'Entra',
    });
    expect(config.appUrl).toBe('https://app.example.com');
    expect(config.apiUrl).toBe('https://api.example.com');
    expect(config.corsOrigins).toEqual(['https://app.example.com']);
    expect(config.databaseAuth).toBe('entra');
  });

  it('accepts extra CORS origins', () => {
    const config = loadConfig({ CORS_ORIGINS: 'https://a.example.com, https://b.example.com/' });
    expect(config.corsOrigins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('requires the web app address and database in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', DATABASE_URL: 'postgres://x/y' })).toThrow(/APP_URL/);
    expect(() => loadConfig({ NODE_ENV: 'production', APP_URL: 'https://app.example.com' })).toThrow(/DATABASE_URL/);
  });

  it('rejects unknown database auth modes', () => {
    expect(() => loadConfig({ DATABASE_AUTH: 'kerberos' })).toThrow(/DATABASE_AUTH/);
  });
});
