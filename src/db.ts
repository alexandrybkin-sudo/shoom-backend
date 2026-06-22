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

  console.log('🗄️  Postgres ready (users, vote_events, match_results, tribe_season_scores)');
}
