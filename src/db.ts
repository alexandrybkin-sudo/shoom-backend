import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export interface User {
  id: string;
  email: string | null;
  display_name: string;
  avatar_url: string | null;
  google_id: string | null;
  vk_id: string | null;
  locale: string;
  username: string | null;
}

// Public shape returned to clients (never includes password_hash).
export function publicUser(u: any): User {
  return {
    id: u.id,
    email: u.email ?? null,
    display_name: u.display_name,
    avatar_url: u.avatar_url ?? null,
    google_id: u.google_id ?? null,
    vk_id: u.vk_id ?? null,
    locale: u.locale ?? 'en',
    username: u.username ?? null,
  };
}

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email         TEXT UNIQUE,
      password_hash TEXT,
      display_name  TEXT NOT NULL,
      avatar_url    TEXT,
      google_id     TEXT UNIQUE,
      vk_id         TEXT UNIQUE,
      locale        TEXT NOT NULL DEFAULT 'en',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // For tables that pre-date the locale column.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en';`);
  // Unique @username handle.
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_username_uniq ON users (username);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS vote_events (
      id          BIGSERIAL PRIMARY KEY,
      match_id    TEXT NOT NULL,
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      round       INT NOT NULL,
      window_idx  INT NOT NULL,
      side        TEXT NOT NULL CHECK (side IN ('A','B')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (match_id, user_id, window_idx)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS match_results (
      match_id      TEXT PRIMARY KEY,
      room_id       TEXT,
      topic         TEXT,
      label_a       TEXT,
      label_b       TEXT,
      winner_side   TEXT NOT NULL CHECK (winner_side IN ('A','B','tie')),
      final_share_a NUMERIC NOT NULL,
      final_share_b NUMERIC NOT NULL,
      swing_winner  TEXT NOT NULL CHECK (swing_winner IN ('A','B','none')),
      swing_pct     NUMERIC NOT NULL,
      total_voters  INT NOT NULL,
      ended_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tribe_season_scores (
      season_id TEXT NOT NULL,
      side_key  TEXT NOT NULL,
      wins      INT NOT NULL DEFAULT 0,
      points    INT NOT NULL DEFAULT 0,
      PRIMARY KEY (season_id, side_key)
    );
  `);

  // --- Forum (persistent discovery layer) ---
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id          BIGSERIAL PRIMARY KEY,
      slug        TEXT UNIQUE NOT NULL,
      emoji       TEXT,
      sort_order  INT NOT NULL DEFAULT 0,
      is_active   BOOLEAN NOT NULL DEFAULT true
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS topics (
      id           BIGSERIAL PRIMARY KEY,
      category_id  BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      slug         TEXT UNIQUE NOT NULL,
      title        TEXT NOT NULL,
      lang         TEXT NOT NULL DEFAULT 'en',
      side_a_label TEXT NOT NULL DEFAULT 'For',
      side_b_label TEXT NOT NULL DEFAULT 'Against',
      created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
      is_seed      BOOLEAN NOT NULL DEFAULT false,
      status       TEXT NOT NULL DEFAULT 'active',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS topic_posts (
      id         BIGSERIAL PRIMARY KEY,
      topic_id   BIGINT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      side       TEXT NOT NULL CHECK (side IN ('A','B')),
      body       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS topic_stats (
      topic_id           BIGINT PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE,
      posts_count        INT NOT NULL DEFAULT 0,
      participants_count INT NOT NULL DEFAULT 0,
      battles_count      INT NOT NULL DEFAULT 0,
      live_battles       INT NOT NULL DEFAULT 0,
      last_activity_at   TIMESTAMPTZ,
      heat_score         NUMERIC NOT NULL DEFAULT 0
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_interests (
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_id BIGINT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, category_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS follows (
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK (target_type IN ('category','topic')),
      target_id   BIGINT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, target_type, target_id)
    );
  `);

  console.log('🗄️  Postgres ready (users, votes, matches, tribes, forum)');
}
