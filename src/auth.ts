import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool, publicUser, User } from './db';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const SUPPORTED_LOCALES = ['en', 'ru', 'es'];
const normalizeLocale = (l: unknown): string =>
  SUPPORTED_LOCALES.includes(String(l)) ? String(l) : 'en';
const COOKIE_NAME = 'shoom_token';
const IS_PROD = process.env.NODE_ENV === 'production';
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
const REDIRECT_BASE = process.env.OAUTH_REDIRECT_BASE || 'http://localhost:3001';

function signToken(user: User): string {
  return jwt.sign(
    { sub: user.id, name: user.display_name },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function setAuthCookie(res: Response, token: string) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

// Reads the current user id from the auth cookie (or null).
export function getUserIdFromReq(req: Request): string | null {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET) as { sub: string };
    return payload.sub;
  } catch {
    return null;
  }
}

// Reads the current user id from a raw Cookie header (used for socket.io handshakes).
export function getUserIdFromCookieHeader(cookieHeader?: string): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)shoom_token=([^;]+)/);
  if (!m) return null;
  try {
    const payload = jwt.verify(decodeURIComponent(m[1]), JWT_SECRET) as { sub: string };
    return payload.sub;
  } catch {
    return null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }
  (req as any).userId = userId;
  next();
}

async function findUserById(id: string) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

// Upsert a social user by provider id, falling back to email match.
async function upsertSocialUser(opts: {
  provider: 'google' | 'vk';
  providerId: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
}) {
  const col = opts.provider === 'google' ? 'google_id' : 'vk_id';

  let { rows } = await pool.query(`SELECT * FROM users WHERE ${col} = $1`, [opts.providerId]);
  if (rows[0]) return rows[0];

  if (opts.email) {
    ({ rows } = await pool.query('SELECT * FROM users WHERE email = $1', [opts.email]));
    if (rows[0]) {
      const updated = await pool.query(
        `UPDATE users SET ${col} = $1, avatar_url = COALESCE(avatar_url, $2) WHERE id = $3 RETURNING *`,
        [opts.providerId, opts.avatarUrl, rows[0].id]
      );
      return updated.rows[0];
    }
  }

  const inserted = await pool.query(
    `INSERT INTO users (email, display_name, avatar_url, ${col})
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [opts.email, opts.displayName, opts.avatarUrl, opts.providerId]
  );
  return inserted.rows[0];
}

export const authRouter = Router();

// --- Email + password ---

authRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, displayName, locale } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }
    if (String(password).length < 6) {
      res.status(400).json({ error: 'password must be at least 6 characters' });
      return;
    }

    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows[0]) {
      res.status(409).json({ error: 'email already registered' });
      return;
    }

    const hash = await bcrypt.hash(password, 10);
    const name = (displayName && String(displayName).trim()) || String(email).split('@')[0];
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, locale) VALUES ($1, $2, $3, $4) RETURNING *`,
      [email, hash, name, normalizeLocale(locale)]
    );

    const user = rows[0];
    setAuthCookie(res, signToken(user));
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error('register error:', e);
    res.status(500).json({ error: 'registration failed' });
  }
});

authRouter.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }

    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user || !user.password_hash) {
      res.status(401).json({ error: 'invalid email or password' });
      return;
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      res.status(401).json({ error: 'invalid email or password' });
      return;
    }

    setAuthCookie(res, signToken(user));
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error('login error:', e);
    res.status(500).json({ error: 'login failed' });
  }
});

authRouter.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

// Update the signed-in user's preferred language.
authRouter.post('/locale', async (req: Request, res: Response) => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }
  const locale = normalizeLocale(req.body?.locale);
  try {
    await pool.query('UPDATE users SET locale = $1 WHERE id = $2', [locale, userId]);
    res.json({ locale });
  } catch (e) {
    console.error('locale update error:', e);
    res.status(500).json({ error: 'failed to update locale' });
  }
});

authRouter.get('/me', async (req: Request, res: Response) => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }
  const user = await findUserById(userId);
  if (!user) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }
  res.json({ user: publicUser(user) });
});

// --- Google OAuth ---

authRouter.get('/google', (_req: Request, res: Response) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    res.status(501).json({ error: 'Google OAuth not configured' });
    return;
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${REDIRECT_BASE}/api/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    prompt: 'select_account',
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

authRouter.get('/google/callback', async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string;
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!code || !clientId || !clientSecret) {
      res.status(400).send('Google OAuth misconfigured');
      return;
    }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${REDIRECT_BASE}/api/auth/google/callback`,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData: any = await tokenRes.json();

    const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const info: any = await infoRes.json();

    const user = await upsertSocialUser({
      provider: 'google',
      providerId: info.sub,
      email: info.email || null,
      displayName: info.name || info.email?.split('@')[0] || 'Player',
      avatarUrl: info.picture || null,
    });

    setAuthCookie(res, signToken(user));
    res.redirect(FRONTEND_URL);
  } catch (e) {
    console.error('google callback error:', e);
    res.redirect(`${FRONTEND_URL}/login?error=google`);
  }
});

// --- VK OAuth ---

authRouter.get('/vk', (_req: Request, res: Response) => {
  const clientId = process.env.VK_CLIENT_ID;
  if (!clientId) {
    res.status(501).json({ error: 'VK OAuth not configured' });
    return;
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${REDIRECT_BASE}/api/auth/vk/callback`,
    response_type: 'code',
    scope: 'email',
    display: 'page',
    v: '5.131',
  });
  res.redirect(`https://oauth.vk.com/authorize?${params}`);
});

authRouter.get('/vk/callback', async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string;
    const clientId = process.env.VK_CLIENT_ID;
    const clientSecret = process.env.VK_CLIENT_SECRET;
    if (!code || !clientId || !clientSecret) {
      res.status(400).send('VK OAuth misconfigured');
      return;
    }

    const tokenParams = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: `${REDIRECT_BASE}/api/auth/vk/callback`,
      code,
    });
    const tokenRes = await fetch(`https://oauth.vk.com/access_token?${tokenParams}`);
    const tokenData: any = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error('no vk access_token: ' + JSON.stringify(tokenData));
    }

    const infoParams = new URLSearchParams({
      user_ids: String(tokenData.user_id),
      fields: 'photo_200',
      access_token: tokenData.access_token,
      v: '5.131',
    });
    const infoRes = await fetch(`https://api.vk.com/method/users.get?${infoParams}`);
    const infoData: any = await infoRes.json();
    const p = infoData.response?.[0] || {};

    const user = await upsertSocialUser({
      provider: 'vk',
      providerId: String(tokenData.user_id),
      email: tokenData.email || null,
      displayName: [p.first_name, p.last_name].filter(Boolean).join(' ') || 'VK Player',
      avatarUrl: p.photo_200 || null,
    });

    setAuthCookie(res, signToken(user));
    res.redirect(FRONTEND_URL);
  } catch (e) {
    console.error('vk callback error:', e);
    res.redirect(`${FRONTEND_URL}/login?error=vk`);
  }
});
