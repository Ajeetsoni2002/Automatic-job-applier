import bcrypt from 'bcryptjs';
import { Router, type CookieOptions, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { getEnv } from '@ja/shared';
import { HttpError, parse } from './http.js';

export const COOKIE_NAME = 'ja_token';
const TOKEN_TTL_SECONDS = 7 * 24 * 3600;

function jwtSecret(): string {
  const secret = getEnv().JWT_SECRET;
  if (!secret || secret.length < 32)
    throw new HttpError(500, 'JWT_SECRET must be set (at least 32 characters)');
  return secret;
}

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: getEnv().NODE_ENV === 'production',
    maxAge: TOKEN_TTL_SECONDS * 1000,
    path: '/',
  };
}

export function signToken(email: string): string {
  return jwt.sign({ sub: email }, jwtSecret(), { expiresIn: TOKEN_TTL_SECONDS });
}

/** Accepts the session cookie (dashboard) or an `Authorization: Bearer` header (scripts). */
export const requireAuth: RequestHandler = (req, res, next) => {
  const header = req.headers.authorization;
  const token =
    (req.cookies?.[COOKIE_NAME] as string | undefined) ??
    (header?.startsWith('Bearer ') ? header.slice(7) : undefined);
  if (!token) throw new HttpError(401, 'Not logged in');
  const secret = jwtSecret();
  try {
    const payload = jwt.verify(token, secret) as { sub?: string };
    res.locals.user = payload.sub;
  } catch {
    throw new HttpError(401, 'Session expired, please log in again');
  }
  next();
};

const LoginSchema = z.object({ email: z.string().trim().min(3), password: z.string().min(1) });

export const authRouter = Router();

authRouter.post(
  '/login',
  rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many login attempts, try again later' },
  }),
  async (req, res) => {
    const { email, password } = parse(LoginSchema, req.body);
    const env = getEnv();
    if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD_HASH)
      throw new HttpError(
        503,
        'Login is not configured: set ADMIN_EMAIL and ADMIN_PASSWORD_HASH in .env',
      );

    const emailOk = email.toLowerCase() === env.ADMIN_EMAIL.toLowerCase();
    // Always run bcrypt so response time doesn't reveal whether the email matched.
    const passwordOk = await bcrypt.compare(password, env.ADMIN_PASSWORD_HASH);
    if (!emailOk || !passwordOk) throw new HttpError(401, 'Wrong email or password');

    res.cookie(COOKIE_NAME, signToken(env.ADMIN_EMAIL), cookieOptions());
    res.json({ email: env.ADMIN_EMAIL });
  },
);

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(), maxAge: undefined });
  res.json({ ok: true });
});

authRouter.get('/me', requireAuth, (_req, res) => {
  res.json({ email: res.locals.user });
});
