import type { Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';

const MINUTE = 60 * 1000;

function limiter(windowMs: number, limit: number, error: string, keyGenerator?: (req: Request) => string) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error },
    ...(keyGenerator ? { keyGenerator } : {}),
  });
}

const TOO_MANY_LOGINS = 'Too many sign-in attempts. Please wait a few minutes and try again.';

/**
 * Request limits, counted per API replica. They slow password guessing and
 * scripted sign-ups, and stop one client from using up the API.
 */
export function rateLimits() {
  return {
    loginPerIp: limiter(15 * MINUTE, 20, TOO_MANY_LOGINS),
    // Also per account, so guesses at one password can't be spread across many addresses.
    loginPerAccount: limiter(15 * MINUTE, 10, TOO_MANY_LOGINS, (req) =>
      `login:${String(req.body?.login ?? '').trim().toLowerCase()}`,
    ),
    signup: limiter(60 * MINUTE, 5, 'Too many new accounts from your network. Please try again later.'),
    googleExchange: limiter(15 * MINUTE, 20, TOO_MANY_LOGINS),
    // Everything else: generous for a person playing, including the refetches live updates trigger.
    api: limiter(MINUTE, 300, 'Too many requests. Please slow down.', (req) =>
      req.user ? `user:${req.user.id}` : ipKeyGenerator(req.ip ?? ''),
    ),
  };
}
