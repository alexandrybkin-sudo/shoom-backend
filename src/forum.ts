import { Router, Request, Response } from 'express';
import { pool } from './db';
import { getUserIdFromReq } from './auth';

// Heat weights (ticket): posts*1 + live*10 + viewers*0.5 + battles*3.
// Implemented as a stored score bumped on events + gentle decay (cheap, non self-zeroing).
const HEAT_POST = 1;
const HEAT_BATTLE_START = 10;
const HEAT_BATTLE_END = 3;
const HEAT_DECAY = 0.985; // per cron tick (~90s)

// --- Live battles bridge (rooms live in index.ts, in-memory) ---
type LiveBattle = { id: string; topic: string; labelA: string; labelB: string; viewers: number; topicId: number | null; isOpen: boolean; isLive: boolean; phase: string };
let liveBattlesProvider: () => LiveBattle[] = () => [];
export function setLiveBattlesProvider(fn: () => LiveBattle[]) {
  liveBattlesProvider = fn;
}

function slugify(s: string): string {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9Ѐ-ӿ\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60) || 'topic';
}

// --- Seed taxonomy + a few topics per language so the forum is not empty ---
const CATEGORIES = [
  { slug: 'money', emoji: '💰' },
  { slug: 'love', emoji: '❤️' },
  { slug: 'parenting', emoji: '👶' },
  { slug: 'lifestyle', emoji: '🏋️' },
  { slug: 'digital', emoji: '📱' },
  { slug: 'auto', emoji: '🚗' },
  { slug: 'culture', emoji: '🍿' },
  { slug: 'science', emoji: '🛸' },
];

const SIDE_LABELS: Record<string, { a: string; b: string }> = {
  en: { a: 'For', b: 'Against' },
  ru: { a: 'За', b: 'Против' },
  es: { a: 'A favor', b: 'En contra' },
};

// 2 concepts per category, each in en/ru/es.
const SEED_TOPICS: Record<string, Array<{ en: string; ru: string; es: string }>> = {
  money: [
    { en: 'Splitting the bill 50/50 on a date is wrong', ru: 'Делить счёт на свидании поровну — неправильно', es: 'Dividir la cuenta 50/50 en una cita está mal' },
    { en: 'Tipping is a scam', ru: 'Чаевые — это развод', es: 'Las propinas son un timo' },
  ],
  love: [
    { en: "Checking your partner's phone is okay", ru: 'Проверять телефон партнёра — нормально', es: 'Revisar el teléfono de tu pareja está bien' },
    { en: 'Long-distance relationships never work', ru: 'Отношения на расстоянии не работают', es: 'Las relaciones a distancia nunca funcionan' },
  ],
  parenting: [
    { en: 'Being childfree is selfish', ru: 'Чайлдфри — это эгоизм', es: 'Ser childfree es egoísta' },
    { en: 'No smartphones for kids under 14', ru: 'Детям нельзя смартфон до 14 лет', es: 'Nada de móviles para menores de 14' },
  ],
  lifestyle: [
    { en: 'Breakfast being the most important meal is a myth', ru: 'Завтрак — самый важный приём пищи: миф', es: 'Que el desayuno sea la comida más importante es un mito' },
    { en: 'Gym culture has gone too far', ru: 'Культ зала зашёл слишком далеко', es: 'La cultura del gym ha ido demasiado lejos' },
  ],
  digital: [
    { en: 'Voice messages are disrespectful', ru: 'Голосовые сообщения — это неуважение', es: 'Los audios de voz son una falta de respeto' },
    { en: 'Leaving someone on read is fine', ru: 'Игнорить прочитанное — нормально', es: 'Dejar a alguien en visto está bien' },
  ],
  auto: [
    { en: 'Big cities should ban private cars', ru: 'В больших городах нужно запретить личные авто', es: 'Las grandes ciudades deberían prohibir los coches privados' },
    { en: 'Electric cars are overrated', ru: 'Электромобили переоценены', es: 'Los coches eléctricos están sobrevalorados' },
  ],
  culture: [
    { en: 'Pineapple belongs on pizza', ru: 'Ананас на пицце — это нормально', es: 'La piña va en la pizza' },
    { en: 'Remakes are ruining cinema', ru: 'Ремейки убивают кино', es: 'Los remakes están arruinando el cine' },
  ],
  science: [
    { en: 'We should colonize Mars', ru: 'Человечеству нужно колонизировать Марс', es: 'Deberíamos colonizar Marte' },
    { en: 'Astrology is complete nonsense', ru: 'Астрология — полная чушь', es: 'La astrología es una tontería' },
  ],
};

export async function seedForum(): Promise<void> {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM categories');
  if (rows[0].n > 0) return; // already seeded

  for (let i = 0; i < CATEGORIES.length; i++) {
    const c = CATEGORIES[i];
    const cat = await pool.query(
      'INSERT INTO categories (slug, emoji, sort_order) VALUES ($1,$2,$3) RETURNING id',
      [c.slug, c.emoji, i]
    );
    const categoryId = cat.rows[0].id;

    const concepts = SEED_TOPICS[c.slug] || [];
    for (let j = 0; j < concepts.length; j++) {
      const concept = concepts[j];
      for (const lang of ['en', 'ru', 'es'] as const) {
        const title = concept[lang];
        const slug = `${slugify(concept.en)}-${lang}`.slice(0, 70);
        const labels = SIDE_LABELS[lang];
        const t = await pool.query(
          `INSERT INTO topics (category_id, slug, title, lang, side_a_label, side_b_label, is_seed)
           VALUES ($1,$2,$3,$4,$5,$6,true) RETURNING id`,
          [categoryId, slug, title, lang, labels.a, labels.b]
        );
        // Real counters from zero — no fabricated activity.
        await pool.query(
          `INSERT INTO topic_stats (topic_id, last_activity_at) VALUES ($1, now())`,
          [t.rows[0].id]
        );
      }
    }
  }
  console.log('🌱 Forum seeded (8 categories, EN/RU/ES topics)');
}

// --- Heat helpers (called from index.ts on battle lifecycle) ---
async function bumpHeat(topicId: number, delta: number) {
  await pool.query(
    'UPDATE topic_stats SET heat_score = heat_score + $2, last_activity_at = now() WHERE topic_id = $1',
    [topicId, delta]
  );
}

export async function onTopicBattleStart(topicId: number) {
  try {
    await pool.query('UPDATE topic_stats SET live_battles = live_battles + 1 WHERE topic_id = $1', [topicId]);
    await bumpHeat(topicId, HEAT_BATTLE_START);
  } catch (e) {
    console.error('onTopicBattleStart error:', e);
  }
}

export async function onTopicBattleEnd(topicId: number) {
  try {
    await pool.query(
      'UPDATE topic_stats SET live_battles = GREATEST(0, live_battles - 1), battles_count = battles_count + 1 WHERE topic_id = $1',
      [topicId]
    );
    await bumpHeat(topicId, HEAT_BATTLE_END);
  } catch (e) {
    console.error('onTopicBattleEnd error:', e);
  }
}

export function startHeatCron() {
  setInterval(() => {
    pool.query('UPDATE topic_stats SET heat_score = heat_score * $1 WHERE heat_score > 0.5', [HEAT_DECAY]).catch(() => {});
  }, 90_000);
}

// --- Router ---
export const forumRouter = Router();

forumRouter.get('/home', async (req: Request, res: Response) => {
  const lang = (req.query.lang as string) || 'en';
  try {
    const categories = await pool.query(
      `SELECT c.id, c.slug, c.emoji,
              COUNT(t.id) FILTER (WHERE t.status = 'active' AND t.lang = $1)::int AS "topicsCount",
              COALESCE(SUM(s.live_battles) FILTER (WHERE t.lang = $1), 0)::int AS "liveBattles",
              COUNT(t.id) FILTER (WHERE t.lang = $1 AND t.created_at > now() - interval '24 hours')::int AS "new24h"
       FROM categories c
       LEFT JOIN topics t ON t.category_id = c.id
       LEFT JOIN topic_stats s ON s.topic_id = t.id
       WHERE c.is_active
       GROUP BY c.id
       ORDER BY c.sort_order`,
      [lang]
    );

    const hot = await pool.query(
      `SELECT t.slug, t.title, t.lang, t.side_a_label AS "sideA", t.side_b_label AS "sideB",
              s.posts_count AS "posts", s.participants_count AS "participants",
              s.battles_count AS "battles", s.live_battles AS "live", s.heat_score AS "heat"
       FROM topics t JOIN topic_stats s ON s.topic_id = t.id
       WHERE t.status = 'active' AND t.lang = $1
       ORDER BY s.heat_score DESC
       LIMIT 8`,
      [lang]
    );

    res.json({
      categories: categories.rows,
      hotTopics: hot.rows,
      liveBattles: liveBattlesProvider(),
    });
  } catch (e) {
    console.error('forum home error:', e);
    res.status(500).json({ error: 'failed to load forum home' });
  }
});

forumRouter.get('/categories/:slug', async (req: Request, res: Response): Promise<void> => {
  const sort = (req.query.sort as string) || 'hot';
  const lang = (req.query.lang as string) || 'en';
  const orderBy =
    sort === 'new' ? 't.created_at DESC' : sort === 'active' ? 's.last_activity_at DESC NULLS LAST' : 's.heat_score DESC';
  try {
    const cat = await pool.query('SELECT id, slug, emoji FROM categories WHERE slug = $1 AND is_active', [req.params.slug]);
    if (!cat.rows[0]) {
      res.status(404).json({ error: 'category not found' });
      return;
    }
    const topics = await pool.query(
      `SELECT t.slug, t.title, t.lang, t.side_a_label AS "sideA", t.side_b_label AS "sideB",
              s.posts_count AS "posts", s.participants_count AS "participants",
              s.battles_count AS "battles", s.live_battles AS "live",
              s.heat_score AS "heat", s.last_activity_at AS "lastActivity"
       FROM topics t JOIN topic_stats s ON s.topic_id = t.id
       WHERE t.category_id = $1 AND t.status = 'active' AND t.lang = $2
       ORDER BY ${orderBy}
       LIMIT 50`,
      [cat.rows[0].id, lang]
    );
    res.json({ category: cat.rows[0], topics: topics.rows });
  } catch (e) {
    console.error('forum category error:', e);
    res.status(500).json({ error: 'failed to load category' });
  }
});

forumRouter.get('/topics/:slug', async (req: Request, res: Response): Promise<void> => {
  const page = Math.max(1, parseInt(String(req.query.page || '1'), 10) || 1);
  const pageSize = 20;
  try {
    const t = await pool.query(
      `SELECT t.id, t.slug, t.title, t.lang, t.side_a_label AS "sideA", t.side_b_label AS "sideB",
              c.slug AS "categorySlug",
              s.posts_count AS "posts", s.participants_count AS "participants",
              s.battles_count AS "battles", s.live_battles AS "live"
       FROM topics t JOIN categories c ON c.id = t.category_id
       JOIN topic_stats s ON s.topic_id = t.id
       WHERE t.slug = $1`,
      [req.params.slug]
    );
    if (!t.rows[0]) {
      res.status(404).json({ error: 'topic not found' });
      return;
    }
    const topic = t.rows[0];
    const posts = await pool.query(
      `SELECT p.side, p.body, p.created_at AS "createdAt", u.display_name AS "author", u.avatar_url AS "avatar"
       FROM topic_posts p JOIN users u ON u.id = p.user_id
       WHERE p.topic_id = $1
       ORDER BY p.created_at ASC
       LIMIT $2 OFFSET $3`,
      [topic.id, pageSize, (page - 1) * pageSize]
    );
    res.json({ topic, posts: posts.rows, hasMore: posts.rows.length === pageSize });
  } catch (e) {
    console.error('forum topic error:', e);
    res.status(500).json({ error: 'failed to load topic' });
  }
});

forumRouter.post('/topics', async (req: Request, res: Response): Promise<void> => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    res.status(401).json({ error: 'sign in to create a topic' });
    return;
  }
  const { categoryId, title, sideA, sideB, lang } = req.body || {};
  if (!categoryId || !title || !String(title).trim()) {
    res.status(400).json({ error: 'categoryId and title are required' });
    return;
  }
  try {
    const cat = await pool.query('SELECT id FROM categories WHERE id = $1 AND is_active', [categoryId]);
    if (!cat.rows[0]) {
      res.status(404).json({ error: 'category not found' });
      return;
    }
    const slug = `${slugify(String(title))}-${Math.random().toString(36).slice(2, 6)}`;
    const topicLang = ['en', 'ru', 'es'].includes(String(lang)) ? String(lang) : 'en';
    const labels = SIDE_LABELS[topicLang];
    const t = await pool.query(
      `INSERT INTO topics (category_id, slug, title, lang, side_a_label, side_b_label, created_by, is_seed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false) RETURNING id, slug`,
      [categoryId, slug, String(title).trim(), topicLang, (sideA || labels.a), (sideB || labels.b), userId]
    );
    await pool.query(
      `INSERT INTO topic_stats (topic_id, last_activity_at, heat_score) VALUES ($1, now(), 5)`,
      [t.rows[0].id]
    );
    res.json({ id: t.rows[0].id, slug: t.rows[0].slug });
  } catch (e) {
    console.error('create topic error:', e);
    res.status(500).json({ error: 'failed to create topic' });
  }
});

// --- User interests (onboarding) ---
forumRouter.get('/interests', async (req: Request, res: Response): Promise<void> => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }
  try {
    const { rows } = await pool.query('SELECT category_id AS "categoryId" FROM user_interests WHERE user_id = $1', [userId]);
    res.json({ categoryIds: rows.map((r) => Number(r.categoryId)) });
  } catch (e) {
    res.status(500).json({ error: 'failed' });
  }
});

forumRouter.post('/interests', async (req: Request, res: Response): Promise<void> => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    res.status(401).json({ error: 'sign in to save interests' });
    return;
  }
  const ids: number[] = Array.isArray(req.body?.categoryIds)
    ? req.body.categoryIds.filter((x: unknown) => Number.isInteger(x))
    : [];
  try {
    await pool.query('DELETE FROM user_interests WHERE user_id = $1', [userId]);
    for (const cid of ids) {
      await pool.query(
        'INSERT INTO user_interests (user_id, category_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [userId, cid]
      );
    }
    res.json({ ok: true, categoryIds: ids });
  } catch (e) {
    console.error('save interests error:', e);
    res.status(500).json({ error: 'failed to save interests' });
  }
});

// --- Follow / subscribe (a category or a topic) ---
forumRouter.post('/follow', async (req: Request, res: Response): Promise<void> => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    res.status(401).json({ error: 'sign in to subscribe' });
    return;
  }
  const targetType = req.body?.targetType;
  const targetId = Number(req.body?.targetId);
  if (!['category', 'topic'].includes(targetType) || !Number.isInteger(targetId)) {
    res.status(400).json({ error: 'bad target' });
    return;
  }
  try {
    const del = await pool.query(
      'DELETE FROM follows WHERE user_id=$1 AND target_type=$2 AND target_id=$3',
      [userId, targetType, targetId]
    );
    if (del.rowCount && del.rowCount > 0) {
      res.json({ following: false });
      return;
    }
    await pool.query(
      'INSERT INTO follows (user_id, target_type, target_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
      [userId, targetType, targetId]
    );
    res.json({ following: true });
  } catch (e) {
    console.error('follow error:', e);
    res.status(500).json({ error: 'failed to subscribe' });
  }
});

forumRouter.get('/follow', async (req: Request, res: Response): Promise<void> => {
  const userId = getUserIdFromReq(req);
  const targetType = String(req.query.targetType || '');
  const targetId = parseInt(String(req.query.targetId || ''), 10);
  if (!userId || !targetId) {
    res.json({ following: false });
    return;
  }
  try {
    const { rows } = await pool.query(
      'SELECT 1 FROM follows WHERE user_id=$1 AND target_type=$2 AND target_id=$3',
      [userId, targetType, targetId]
    );
    res.json({ following: rows.length > 0 });
  } catch {
    res.json({ following: false });
  }
});

forumRouter.post('/topics/:id/posts', async (req: Request, res: Response): Promise<void> => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    res.status(401).json({ error: 'sign in to reply' });
    return;
  }
  const topicId = parseInt(String(req.params.id), 10);
  const { side, body } = req.body || {};
  if ((side !== 'A' && side !== 'B') || !body || !String(body).trim()) {
    res.status(400).json({ error: 'side (A/B) and body are required' });
    return;
  }
  try {
    const exists = await pool.query('SELECT id FROM topics WHERE id = $1', [topicId]);
    if (!exists.rows[0]) {
      res.status(404).json({ error: 'topic not found' });
      return;
    }
    await pool.query(
      'INSERT INTO topic_posts (topic_id, user_id, side, body) VALUES ($1,$2,$3,$4)',
      [topicId, userId, side, String(body).trim().slice(0, 2000)]
    );
    // Bump denormalized counters (seed values are a base, so increment rather than recompute).
    // participants only grows when this is the author's first post in the topic.
    await pool.query(
      `UPDATE topic_stats s SET
         posts_count = s.posts_count + 1,
         participants_count = s.participants_count +
           CASE WHEN (SELECT COUNT(*) FROM topic_posts WHERE topic_id = $1 AND user_id = $3) = 1 THEN 1 ELSE 0 END,
         last_activity_at = now(),
         heat_score = s.heat_score + $2
       WHERE s.topic_id = $1`,
      [topicId, HEAT_POST, userId]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('create post error:', e);
    res.status(500).json({ error: 'failed to post' });
  }
});
