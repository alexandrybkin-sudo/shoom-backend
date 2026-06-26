import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import { pool, publicUser } from './db';
import { getUserIdFromReq } from './auth';

export const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
const AVATAR_DIR = path.join(UPLOADS_DIR, 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const SUPPORTED_LOCALES = ['en', 'ru', 'es'];
const BIO_MAX = 140;
const DISPLAY_NAME_MAX = 40;
const PASSWORD_MIN = 8;

// --- Tiny in-memory per-user rate limiter (no external dep) ---
const hits = new Map<string, number[]>();
function rateLimited(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) {
    hits.set(key, arr);
    return true;
  }
  arr.push(now);
  hits.set(key, arr);
  return false;
}

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('unsupported file type'));
  },
});

export const profileRouter = Router();

// ---------------------------------------------------------------------------
// Public profile
// ---------------------------------------------------------------------------
profileRouter.get('/users/:handle/profile', async (req: Request, res: Response): Promise<void> => {
  const handle = String(req.params.handle || '').toLowerCase();
  const me = getUserIdFromReq(req);

  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [handle]);
  const u = rows[0];

  if (!u) {
    // Maybe an old handle → tell the client where to redirect.
    const { rows: h } = await pool.query(
      `SELECT cur.username AS current FROM handle_history hh
         JOIN users cur ON cur.id = hh.user_id
        WHERE hh.old_username = $1`,
      [handle]
    );
    if (h[0]?.current) {
      res.json({ redirectTo: h[0].current });
      return;
    }
    res.status(404).json({ error: 'user not found' });
    return;
  }

  try {
    const [counts, interests, camps, followsMe] = await Promise.all([
      pool.query(
        `SELECT
           (SELECT count(*)::int FROM user_follows WHERE followee_id = $1) AS followers,
           (SELECT count(*)::int FROM user_follows WHERE follower_id = $1) AS following`,
        [u.id]
      ),
      pool.query(
        `SELECT c.slug FROM user_interests ui
           JOIN categories c ON c.id = ui.category_id
          WHERE ui.user_id = $1
          ORDER BY c.sort_order`,
        [u.id]
      ),
      pool.query(
        `SELECT DISTINCT ON (t.id) t.slug, t.title, tp.side, c.slug AS category
           FROM topic_posts tp
           JOIN topics t ON t.id = tp.topic_id
           JOIN categories c ON c.id = t.category_id
          WHERE tp.user_id = $1
          ORDER BY t.id, tp.created_at DESC
          LIMIT 12`,
        [u.id]
      ),
      me
        ? pool.query('SELECT 1 FROM user_follows WHERE follower_id = $1 AND followee_id = $2', [me, u.id])
        : Promise.resolve({ rows: [] as any[] }),
    ]);

    res.json({
      id: u.id,
      handle: u.username,
      nickname: u.display_name,
      avatarUrl: u.avatar_url ?? null,
      bio: u.bio ?? null,
      joinedAt: u.created_at,
      opinionMapPublic: u.opinion_map_public ?? true,
      followers: counts.rows[0].followers,
      following: counts.rows[0].following,
      isFollowedByMe: followsMe.rows.length > 0,
      isSelf: me === u.id,
      interests: interests.rows.map((r) => r.slug),
      camps: camps.rows,
    });
  } catch (e) {
    console.error('profile load error:', e);
    res.status(500).json({ error: 'failed to load profile' });
  }
});

// ---------------------------------------------------------------------------
// Follow / unfollow a user
// ---------------------------------------------------------------------------
async function resolveUserIdByHandle(handle: string): Promise<string | null> {
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [handle.toLowerCase()]);
  return rows[0]?.id ?? null;
}

profileRouter.post('/users/:handle/follow', async (req: Request, res: Response): Promise<void> => {
  const me = getUserIdFromReq(req);
  if (!me) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }
  const targetId = await resolveUserIdByHandle(String(req.params.handle));
  if (!targetId) {
    res.status(404).json({ error: 'user not found' });
    return;
  }
  if (targetId === me) {
    res.status(400).json({ error: 'cannot follow yourself' });
    return;
  }
  try {
    await pool.query(
      'INSERT INTO user_follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [me, targetId]
    );
    res.json({ following: true });
  } catch (e) {
    console.error('follow error:', e);
    res.status(500).json({ error: 'failed to follow' });
  }
});

profileRouter.delete('/users/:handle/follow', async (req: Request, res: Response): Promise<void> => {
  const me = getUserIdFromReq(req);
  if (!me) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }
  const targetId = await resolveUserIdByHandle(String(req.params.handle));
  if (!targetId) {
    res.status(404).json({ error: 'user not found' });
    return;
  }
  try {
    await pool.query('DELETE FROM user_follows WHERE follower_id = $1 AND followee_id = $2', [me, targetId]);
    res.json({ following: false });
  } catch (e) {
    console.error('unfollow error:', e);
    res.status(500).json({ error: 'failed to unfollow' });
  }
});

// ---------------------------------------------------------------------------
// Settings: profile fields (bio / locale / display name / opinion-map privacy)
// ---------------------------------------------------------------------------
profileRouter.patch('/me/profile', async (req: Request, res: Response): Promise<void> => {
  const me = getUserIdFromReq(req);
  if (!me) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }

  const sets: string[] = [];
  const vals: any[] = [];
  const body = req.body || {};

  if (body.bio !== undefined) {
    const bio = body.bio === null ? null : String(body.bio).trim().slice(0, BIO_MAX);
    sets.push(`bio = $${sets.length + 1}`);
    vals.push(bio || null);
  }
  if (body.display_name !== undefined) {
    const dn = String(body.display_name).trim().slice(0, DISPLAY_NAME_MAX);
    if (!dn) {
      res.status(400).json({ error: 'display name cannot be empty' });
      return;
    }
    sets.push(`display_name = $${sets.length + 1}`);
    vals.push(dn);
  }
  if (body.locale !== undefined) {
    const loc = SUPPORTED_LOCALES.includes(String(body.locale)) ? String(body.locale) : 'en';
    sets.push(`locale = $${sets.length + 1}`);
    vals.push(loc);
  }
  if (body.opinionMapPublic !== undefined) {
    sets.push(`opinion_map_public = $${sets.length + 1}`);
    vals.push(!!body.opinionMapPublic);
  }

  if (sets.length === 0) {
    res.status(400).json({ error: 'nothing to update' });
    return;
  }

  try {
    vals.push(me);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    res.json({ user: publicUser(rows[0]) });
  } catch (e) {
    console.error('profile update error:', e);
    res.status(500).json({ error: 'failed to update profile' });
  }
});

// ---------------------------------------------------------------------------
// Settings: password
// ---------------------------------------------------------------------------
profileRouter.patch('/me/password', async (req: Request, res: Response): Promise<void> => {
  const me = getUserIdFromReq(req);
  if (!me) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }
  if (rateLimited(`pw:${me}`, 5, 60_000)) {
    res.status(429).json({ error: 'too many attempts, slow down' });
    return;
  }

  const currentPassword = String(req.body?.currentPassword ?? '');
  const newPassword = String(req.body?.newPassword ?? '');

  if (newPassword.length < PASSWORD_MIN) {
    res.status(400).json({ error: `new password must be at least ${PASSWORD_MIN} characters` });
    return;
  }

  try {
    const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [me]);
    const hash: string | null = rows[0]?.password_hash ?? null;
    // Social-only accounts have no password yet — allow setting one without a current.
    if (hash) {
      const ok = await bcrypt.compare(currentPassword, hash);
      if (!ok) {
        res.status(403).json({ error: 'current password is incorrect' });
        return;
      }
    }
    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, me]);
    res.json({ ok: true });
  } catch (e) {
    console.error('password update error:', e);
    res.status(500).json({ error: 'failed to update password' });
  }
});

// ---------------------------------------------------------------------------
// Settings: avatar upload (resize → local volume, served by express.static)
// ---------------------------------------------------------------------------
profileRouter.post('/me/avatar', (req: Request, res: Response): void => {
  const me = getUserIdFromReq(req);
  if (!me) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }
  if (rateLimited(`av:${me}`, 10, 60_000)) {
    res.status(429).json({ error: 'too many uploads, slow down' });
    return;
  }

  avatarUpload.single('avatar')(req, res, async (err: any) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'image must be ≤ 5 MB' : 'invalid image';
      res.status(400).json({ error: msg });
      return;
    }
    const file = (req as any).file as { buffer: Buffer } | undefined;
    if (!file) {
      res.status(400).json({ error: 'no file' });
      return;
    }
    try {
      const base = path.join(AVATAR_DIR, me);
      await sharp(file.buffer).resize(256, 256, { fit: 'cover' }).webp({ quality: 82 }).toFile(`${base}.webp`);
      await sharp(file.buffer).resize(64, 64, { fit: 'cover' }).webp({ quality: 80 }).toFile(`${base}_64.webp`);
      const url = `/api/uploads/avatars/${me}.webp?v=${Date.now()}`;
      const { rows } = await pool.query(
        'UPDATE users SET avatar_url = $1 WHERE id = $2 RETURNING *',
        [url, me]
      );
      res.json({ user: publicUser(rows[0]) });
    } catch (e) {
      console.error('avatar processing error:', e);
      res.status(500).json({ error: 'failed to process image' });
    }
  });
});
