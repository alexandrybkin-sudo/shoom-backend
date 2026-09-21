import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from './db';
import { getUserIdFromReq } from './auth';

// The bot is dual-purpose: the same @bot handles Telegram Login (see auth.ts) and,
// here, notification delivery. A bot may only DM a user who has pressed Start, so
// notifications require an explicit opt-in via a /start deep link (not Login alone).

const SITE = process.env.FRONTEND_URL || 'https://shoom.fun';

export function telegramEnabled(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}
function botUsername(): string | null {
  return process.env.TELEGRAM_BOT_USERNAME || null;
}
async function tgApi(method: string, payload: unknown, timeoutMs = 15000): Promise<any> {
  if (!telegramEnabled()) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await r.json();
  } catch (e) {
    console.error(`tg ${method} error:`, e);
    return null;
  }
}

export async function sendTelegram(chatId: string, text: string, button?: { label: string; url: string }) {
  const payload: any = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (button) payload.reply_markup = { inline_keyboard: [[{ text: button.label, url: button.url }]] };
  return tgApi('sendMessage', payload);
}

const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --- Notifications --------------------------------------------------------

type Loc = 'en' | 'ru' | 'es';
const loc = (l: unknown): Loc => (l === 'ru' || l === 'es' ? l : 'en');

const T = {
  newPost: {
    en: (title: string, who: string) => `💬 New reply in “${title}” from <b>${who}</b>`,
    ru: (title: string, who: string) => `💬 Новый ответ в теме «${title}» от <b>${who}</b>`,
    es: (title: string, who: string) => `💬 Nueva respuesta en «${title}» de <b>${who}</b>`,
  },
  open: { en: 'Open thread', ru: 'Открыть тему', es: 'Abrir tema' },
};

// Notify people connected to a topic when a new post lands: its author, its
// subscribers, and anyone who has posted in it — minus the poster themselves.
export async function notifyNewPost(opts: {
  topicId: number;
  topicTitle: string;
  topicSlug: string;
  topicAuthor: string | null;
  posterId: string;
  posterName: string;
  snippet: string;
}): Promise<void> {
  if (!telegramEnabled()) return;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT u.id, u.telegram_chat_id, u.locale
         FROM users u
        WHERE u.telegram_chat_id IS NOT NULL
          AND u.tg_notify = true
          AND u.id <> $2
          AND (
            u.id = $3
            OR u.id IN (SELECT user_id FROM follows WHERE target_type = 'topic' AND target_id = $1)
            OR u.id IN (SELECT user_id FROM topic_posts WHERE topic_id = $1)
          )`,
      [opts.topicId, opts.posterId, opts.topicAuthor]
    );
    if (!rows.length) return;
    const url = `${SITE}/t/${opts.topicSlug}`;
    const who = esc(opts.posterName);
    const title = esc(opts.topicTitle);
    const snippet = opts.snippet ? `\n<i>${esc(opts.snippet.slice(0, 160))}</i>` : '';
    for (const r of rows) {
      const l = loc(r.locale);
      const text = T.newPost[l](title, who) + snippet;
      // Deliver sequentially; failures (user blocked the bot, etc.) shouldn't abort the rest.
      await sendTelegram(r.telegram_chat_id, text, { label: T.open[l], url }).catch(() => {});
    }
  } catch (e) {
    console.error('notifyNewPost error:', e);
  }
}

// --- Webhook + account linking -------------------------------------------

export const telegramRouter = Router();

// Public: the frontend needs the bot username to build the Login widget & deep link.
telegramRouter.get('/config', (_req: Request, res: Response) => {
  res.json({ bot: botUsername() });
});

// Auth: current connection state + a fresh deep link to connect notifications.
telegramRouter.get('/link', async (req: Request, res: Response) => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }
  const bot = botUsername();
  if (!bot || !telegramEnabled()) {
    res.json({ enabled: false, connected: false, notify: false, url: null });
    return;
  }
  try {
    const { rows } = await pool.query(
      'SELECT telegram_chat_id, tg_notify FROM users WHERE id = $1',
      [userId]
    );
    const connected = !!rows[0]?.telegram_chat_id;
    // One active token per user: clear old ones, issue a fresh nonce.
    const token = crypto.randomBytes(24).toString('base64url');
    await pool.query('DELETE FROM telegram_link_tokens WHERE user_id = $1', [userId]);
    await pool.query(
      'INSERT INTO telegram_link_tokens (token, user_id) VALUES ($1, $2)',
      [token, userId]
    );
    res.json({
      enabled: true,
      connected,
      notify: rows[0]?.tg_notify ?? true,
      url: `https://t.me/${bot}?start=${token}`,
    });
  } catch (e) {
    console.error('telegram link error:', e);
    res.status(500).json({ error: 'failed' });
  }
});

// Auth: turn notifications on/off without disconnecting.
telegramRouter.post('/notify', async (req: Request, res: Response) => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }
  const on = req.body?.on !== false;
  try {
    await pool.query('UPDATE users SET tg_notify = $1 WHERE id = $2', [on, userId]);
    res.json({ notify: on });
  } catch (e) {
    console.error('telegram notify toggle error:', e);
    res.status(500).json({ error: 'failed' });
  }
});

// Auth: unlink the chat entirely (stops all DMs).
telegramRouter.post('/disconnect', async (req: Request, res: Response) => {
  const userId = getUserIdFromReq(req);
  if (!userId) {
    res.status(401).json({ error: 'not authenticated' });
    return;
  }
  try {
    await pool.query('UPDATE users SET telegram_chat_id = NULL WHERE id = $1', [userId]);
    res.json({ connected: false });
  } catch (e) {
    console.error('telegram disconnect error:', e);
    res.status(500).json({ error: 'failed' });
  }
});

// Process one incoming bot message. Only /start (with a deep-link token) is
// actionable: it links the Telegram chat to the account that generated the token.
async function handleTelegramMessage(msg: any): Promise<void> {
  try {
    const text: string = msg?.text || '';
    const chatId = msg?.chat?.id;
    if (!chatId || !text.startsWith('/start')) return;

    const parts = text.split(/\s+/);
    const token = parts[1];
    const l = loc(msg?.from?.language_code?.slice(0, 2));
    if (!token) {
      // Bare /start (no deep-link token): greet, but we can't link without a token.
      const hi = {
        en: 'Hi! Open the “Connect Telegram” button in your Shoom profile to link notifications.',
        ru: 'Привет! Нажмите «Подключить Telegram» в профиле Shoom, чтобы получать уведомления.',
        es: '¡Hola! Pulsa «Conectar Telegram» en tu perfil de Shoom para activar las notificaciones.',
      }[l];
      await sendTelegram(String(chatId), hi);
      return;
    }
    const { rows } = await pool.query(
      'SELECT user_id FROM telegram_link_tokens WHERE token = $1',
      [token]
    );
    const linkUserId = rows[0]?.user_id;
    if (!linkUserId) {
      await sendTelegram(String(chatId), {
        en: 'This link has expired. Generate a new one from your Shoom profile.',
        ru: 'Ссылка устарела. Сгенерируйте новую в профиле Shoom.',
        es: 'Este enlace caducó. Genera uno nuevo desde tu perfil de Shoom.',
      }[l]);
      return;
    }
    await pool.query('UPDATE users SET telegram_chat_id = $1, tg_notify = true WHERE id = $2', [
      String(chatId),
      linkUserId,
    ]);
    await pool.query('DELETE FROM telegram_link_tokens WHERE user_id = $1', [linkUserId]);
    await sendTelegram(String(chatId), {
      en: '✅ Connected! You’ll get a ping when someone replies in your threads.',
      ru: '✅ Готово! Пришлём уведомление, когда кто-то ответит в ваших ветках.',
      es: '✅ ¡Listo! Te avisaremos cuando alguien responda en tus temas.',
    }[l]);
  } catch (e) {
    console.error('telegram message error:', e);
  }
}

// --- Long polling ---------------------------------------------------------
// This RU host can't receive Telegram's inbound webhook (their IPs are filtered
// both ways), so instead we PULL updates with getUpdates over our IPv6 egress —
// a purely outbound connection, which works. Single-process only.

let polling = false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollLoop(): Promise<void> {
  let offset = 0;
  while (polling) {
    // Long poll: Telegram holds the request up to `timeout`s, replying the instant
    // an update arrives. The fetch timeout sits above it so a stalled socket recovers.
    const r = await tgApi('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] }, 50000);
    if (r?.ok && Array.isArray(r.result)) {
      for (const u of r.result) {
        offset = u.update_id + 1;
        if (u.message) await handleTelegramMessage(u.message);
      }
    } else {
      // Network hiccup / error / timeout — back off, then resume from the same offset.
      await sleep(5000);
    }
  }
}

export async function startTelegramPolling(): Promise<void> {
  if (!telegramEnabled() || polling) return;
  // getUpdates conflicts (409) with an active webhook; make sure none is set.
  await tgApi('deleteWebhook', { drop_pending_updates: false });
  polling = true;
  console.log('🤖 Telegram bot: long-polling started');
  pollLoop().catch((e) => {
    polling = false;
    console.error('tg poll loop crashed:', e);
  });
}
