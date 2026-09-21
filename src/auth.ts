import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool, publicUser, User } from './db';

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-change-me';
const SUPPORTED_LOCALES = ['en', 'ru', 'es'];
const normalizeLocale = (l: unknown): string =>
  SUPPORTED_LOCALES.includes(String(l)) ? String(l) : 'en';

// Usernames: 3–20 chars, lowercase a-z 0-9 and underscore.
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;
// How long a handle change is locked, and how long an old handle stays reserved.
const HANDLE_COOLDOWN_DAYS = 30;
const HANDLE_RESERVE_DAYS = 30;
function normalizeUsername(u: unknown): string | null {
  const s = String(u ?? '').trim().toLowerCase();
  return USERNAME_RE.test(s) ? s : null;
}
async function usernameTaken(username: string, exceptUserId?: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM users WHERE username = $1 ${exceptUserId ? 'AND id <> $2' : ''}`,
    exceptUserId ? [username, exceptUserId] : [username]
  );
  if (rows.length > 0) return true;
  // Also reserved if another user changed away from this handle recently.
  const { rows: hist } = await pool.query(
    `SELECT 1 FROM handle_history
       WHERE old_username = $1
         AND changed_at > now() - ($2 || ' days')::interval
         ${exceptUserId ? 'AND user_id <> $3' : ''}`,
    exceptUserId ? [username, HANDLE_RESERVE_DAYS, exceptUserId] : [username, HANDLE_RESERVE_DAYS]
  );
  return hist.length > 0;
}
// Derive a free, valid username from a name/email seed.
async function generateUsername(seed: string): Promise<string> {
  let base = String(seed || 'user').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 16);
  if (base.length < 3) base = `user${base}`;
  let candidate = base;
  for (let i = 0; i < 30; i++) {
    if (!(await usernameTaken(candidate))) return candidate;
    candidate = `${base.slice(0, 14)}${Math.floor(Math.random() * 9000 + 1000)}`;
  }
  return `${base.slice(0, 12)}${Date.now().toString().slice(-6)}`;
}
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
  provider: 'yandex' | 'vk';
  providerId: string;
  email: string | null;
  displayName: string;
  avatarUrl: string | null;
}) {
  const col = opts.provider === 'yandex' ? 'yandex_id' : 'vk_id';

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

  const uname = await generateUsername(opts.displayName || opts.email || 'user');
  const inserted = await pool.query(
    `INSERT INTO users (email, display_name, avatar_url, ${col}, username)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [opts.email, opts.displayName, opts.avatarUrl, opts.providerId, uname]
  );
  return inserted.rows[0];
}

export const authRouter = Router();

// --- Email + password ---

authRouter.post('/register', async (req: Request, res: Response) => {
  try {
    const { email, password, displayName, locale, username } = req.body || {};
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

    // Resolve username: validate if given (else auto-generate from email/name).
    let uname: string;
    if (username !== undefined && username !== null && String(username).trim() !== '') {
      const norm = normalizeUsername(username);
      if (!norm) {
        res.status(400).json({ error: 'username must be 3–20 chars: a–z, 0–9, _' });
        return;
      }
      if (await usernameTaken(norm)) {
        res.status(409).json({ error: 'username already taken' });
        return;
      }
      uname = norm;
    } else {
      uname = await generateUsername(String(email).split('@')[0]);
    }

    const hash = await bcrypt.hash(password, 10);
    const name = (displayName && String(displayName).trim()) || String(email).split('@')[0];
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, display_name, locale, username) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [email, hash, name, normalizeLocale(locale), uname]
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

// Check whether a username is valid and free.
authRouter.get('/username-available', async (req: Request, res: Response): Promise<void> => {
  const norm = normalizeUsername(req.query.u);
  if (!norm) {
    res.json({ valid: false, available: false });
    return;
  }
  res.json({ valid: true, available: !(await usernameTaken(norm)) });
});

// Change the signed-in user's username.
authRouter.post('/username', async (req: Request, res: Response): Promise<void> => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }
  const norm = normalizeUsername(req.body?.username);
  if (!norm) {
    res.status(400).json({ error: 'username must be 3–20 chars: a–z, 0–9, _' });
    return;
  }
  if (await usernameTaken(norm, userId)) {
    res.status(409).json({ error: 'username already taken' });
    return;
  }
  try {
    const cur = await pool.query(
      'SELECT username, nickname_changed_at FROM users WHERE id = $1',
      [userId]
    );
    const oldUsername: string | null = cur.rows[0]?.username ?? null;
    const changedAt: Date | null = cur.rows[0]?.nickname_changed_at ?? null;

    // No-op if unchanged.
    if (oldUsername === norm) {
      const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      res.json({ user: publicUser(rows[0]) });
      return;
    }

    // Cooldown between handle changes.
    if (changedAt) {
      const nextAllowed = new Date(changedAt).getTime() + HANDLE_COOLDOWN_DAYS * 86400000;
      if (Date.now() < nextAllowed) {
        res.status(429).json({
          error: 'handle was changed recently',
          nextAllowedAt: new Date(nextAllowed).toISOString(),
          cooldownDays: HANDLE_COOLDOWN_DAYS,
        });
        return;
      }
    }

    const { rows } = await pool.query(
      'UPDATE users SET username = $1, nickname_changed_at = now() WHERE id = $2 RETURNING *',
      [norm, userId]
    );
    // Reserve the old handle so it can't be grabbed (and can redirect) for a while.
    if (oldUsername) {
      await pool.query(
        `INSERT INTO handle_history (old_username, user_id, changed_at)
           VALUES ($1, $2, now())
         ON CONFLICT (old_username) DO UPDATE SET user_id = EXCLUDED.user_id, changed_at = now()`,
        [oldUsername, userId]
      );
    }
    res.json({ user: publicUser(rows[0]) });
  } catch (e) {
    console.error('username update error:', e);
    res.status(500).json({ error: 'failed to update username' });
  }
});

// --- Yandex OAuth ---

authRouter.get('/yandex', (_req: Request, res: Response) => {
  const clientId = process.env.YANDEX_CLIENT_ID;
  if (!clientId) {
    res.status(501).json({ error: 'Yandex OAuth not configured' });
    return;
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${REDIRECT_BASE}/api/auth/yandex/callback`,
    response_type: 'code',
  });
  res.redirect(`https://oauth.yandex.ru/authorize?${params}`);
});

authRouter.get('/yandex/callback', async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string;
    const clientId = process.env.YANDEX_CLIENT_ID;
    const clientSecret = process.env.YANDEX_CLIENT_SECRET;
    if (!code || !clientId || !clientSecret) {
      res.status(400).send('Yandex OAuth misconfigured');
      return;
    }

    const tokenRes = await fetch('https://oauth.yandex.ru/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${REDIRECT_BASE}/api/auth/yandex/callback`,
      }),
    });
    const tokenData: any = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error('no yandex access_token: ' + JSON.stringify(tokenData));
    }

    const infoRes = await fetch('https://login.yandex.ru/info?format=json', {
      headers: { Authorization: `OAuth ${tokenData.access_token}` },
    });
    const info: any = await infoRes.json();

    const displayName =
      info.display_name ||
      info.real_name ||
      [info.first_name, info.last_name].filter(Boolean).join(' ') ||
      info.login ||
      'Player';
    const avatarUrl =
      info.default_avatar_id && !info.is_avatar_empty
        ? `https://avatars.yandex.net/get-yapic/${info.default_avatar_id}/islands-200`
        : null;

    const user = await upsertSocialUser({
      provider: 'yandex',
      providerId: String(info.id),
      email: info.default_email || (info.emails && info.emails[0]) || null,
      displayName,
      avatarUrl,
    });

    setAuthCookie(res, signToken(user));
    res.redirect(FRONTEND_URL);
  } catch (e) {
    console.error('yandex callback error:', e);
    res.redirect(`${FRONTEND_URL}/login?error=yandex`);
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
