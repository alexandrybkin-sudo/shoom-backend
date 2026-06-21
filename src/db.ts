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
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log('🗄️  Postgres ready (users table ensured)');
}
