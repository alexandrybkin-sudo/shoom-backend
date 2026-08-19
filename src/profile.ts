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
    const [counts, interests, camps, followsMe, dstats, history, vstats, opinion] = await Promise.all([
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
          WHERE tp.user_id = $1 AND tp.hidden_at IS NULL AND tp.kind = 'post'
          ORDER BY t.id, tp.created_at DESC
          LIMIT 12`,
        [u.id]
      ),
      me
        ? pool.query('SELECT 1 FROM user_follows WHERE follower_id = $1 AND followee_id = $2', [me, u.id])
        : Promise.resolve({ rows: [] as any[] }),
      // Debater record (from match_results, which stores both debater ids + winner).
      pool.query(
        `SELECT
           count(*)::int AS battles,
           count(*) FILTER (WHERE winner_user_id = $1)::int AS wins,
           count(*) FILTER (WHERE winner_side = 'tie')::int AS ties,
           count(*) FILTER (WHERE winner_side <> 'tie' AND winner_user_id IS DISTINCT FROM $1)::int AS losses
         FROM match_results
         WHERE debater_a_id = $1 OR debater_b_id = $1`,
        [u.id]
      ),
      // Recent matches with the user's side, result and opponent.
      pool.query(
        `SELECT mr.match_id, mr.topic, mr.label_a, mr.label_b, mr.winner_side,
                mr.final_share_a, mr.final_share_b, mr.total_voters, mr.ended_at,
                CASE WHEN mr.debater_a_id = $1 THEN 'A' ELSE 'B' END AS my_side,
                CASE WHEN mr.winner_side = 'tie' THEN 'tie'
                     WHEN mr.winner_user_id = $1 THEN 'win'
                     ELSE 'loss' END AS result,
                opp.display_name AS opponent, opp.username AS opponent_handle
           FROM match_results mr
           LEFT JOIN users opp
             ON opp.id = CASE WHEN mr.debater_a_id = $1 THEN mr.debater_b_id ELSE mr.debater_a_id END
          WHERE mr.debater_a_id = $1 OR mr.debater_b_id = $1
          ORDER BY mr.ended_at DESC
          LIMIT 20`,
        [u.id]
      ),
      // Viewer prediction accuracy: the user's final (last-window) vote per match
      // vs the verdict, excluding ties.
      pool.query(
        `WITH last_vote AS (
           SELECT DISTINCT ON (ve.match_id) ve.match_id, ve.side
             FROM vote_events ve
            WHERE ve.user_id = $1
            ORDER BY ve.match_id, ve.window_idx DESC
         )
         SELECT
           count(DISTINCT lv.match_id)::int AS voted_matches,
           count(*) FILTER (WHERE mr.winner_side <> 'tie')::int AS predictions,
           count(*) FILTER (WHERE mr.winner_side <> 'tie' AND lv.side = mr.winner_side)::int AS correct
         FROM last_vote lv
         JOIN match_results mr ON mr.match_id = lv.match_id`,
        [u.id]
      ),
      // Opinion map: the user's stance per thread from their posts. side = the side
      // they posted on most; conviction = how lopsided; strength = post count.
      pool.query(
        `SELECT t.slug, t.title, c.slug AS category,
                count(*) FILTER (WHERE tp.side = 'A')::int AS na,
                count(*) FILTER (WHERE tp.side = 'B')::int AS nb
           FROM topic_posts tp
           JOIN topics t ON t.id = tp.topic_id
           JOIN categories c ON c.id = t.category_id
          WHERE tp.user_id = $1 AND tp.hidden_at IS NULL AND tp.kind = 'post'
          GROUP BY t.id, t.slug, t.title, c.slug
         HAVING count(*) FILTER (WHERE tp.side IN ('A','B')) > 0
          ORDER BY count(*) DESC
          LIMIT 24`,
        [u.id]
      ),
    ]);

    const ds = dstats.rows[0];
    const vs = vstats.rows[0];

    // Opinion map — stance per thread, overall lean, gated by privacy.
    const omTopics = opinion.rows.map((r: any) => {
      const w = r.na + r.nb;
      return {
        slug: r.slug,
        title: r.title,
        category: r.category,
        side: r.na >= r.nb ? 'A' : 'B',
        strength: w,
        conviction: w > 0 ? Math.max(r.na, r.nb) / w : 0.5,
      };
    });
    const totalW = omTopics.reduce((s, t) => s + t.strength, 0);
    const forW = omTopics.filter((t) => t.side === 'A').reduce((s, t) => s + t.strength, 0);
    const forPct = totalW > 0 ? Math.round((forW / totalW) * 100) : 50;
    const omVisible = me === u.id || (u.opinion_map_public ?? true);
    const opinionMap = omVisible
      ? { topics: omTopics, forPct, total: omTopics.length }
      : { hidden: true, total: omTopics.length };

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
      debaterStats: {
        battles: ds.battles,
        wins: ds.wins,
        losses: ds.losses,
        ties: ds.ties,
        winRate: ds.battles > 0 ? ds.wins / ds.battles : 0,
      },
      matchHistory: history.rows.map((r) => ({
        matchId: r.match_id,
        topic: r.topic,
        labelA: r.label_a,
        labelB: r.label_b,
        winnerSide: r.winner_side,
        finalShareA: Number(r.final_share_a),
        finalShareB: Number(r.final_share_b),
        totalVoters: r.total_voters,
        endedAt: r.ended_at,
        mySide: r.my_side,
        result: r.result,
        opponent: r.opponent ?? null,
        opponentHandle: r.opponent_handle ?? null,
      })),
      viewerStats: {
        votedMatches: vs.voted_matches,
        predictions: vs.predictions,
        correct: vs.correct,
        accuracy: vs.predictions > 0 ? vs.correct / vs.predictions : 0,
      },
      opinionMap,
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
