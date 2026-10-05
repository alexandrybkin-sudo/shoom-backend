import { Router, Request, Response } from 'express';
import { getUserIdFromReq } from './auth';
import { moderate } from './moderation';

// AI debate coach: a 1-on-1 practice debate against the model. The AI picks the
// topic and assigns the human a side, the human answers under a timer (enforced
// client-side), and at the end the AI critiques the human's performance by debate
// methodology. Backend is stateless — the transcript is passed in per request.

const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
export const coachEnabled = () => !!API_KEY;

type Msg = { role: 'system' | 'user' | 'assistant'; content: string };

async function callDeepSeek(
  messages: Msg[],
  opts: { json?: boolean; maxTokens?: number; temp?: number } = {}
): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL,
        temperature: opts.temp ?? 0.8,
        max_tokens: opts.maxTokens ?? 300,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        messages,
      }),
    });
    if (!res.ok) throw new Error(`deepseek ${res.status}`);
    const data = await res.json();
    return String(data.choices?.[0]?.message?.content || '');
  } finally {
    clearTimeout(timer);
  }
}

const LANG: Record<string, string> = { ru: 'русском', en: 'English', es: 'español' };
const langName = (l: unknown) => LANG[String(l)] || LANG.ru;
const sideLabels = (l: string) =>
  l === 'en' ? { a: 'For', b: 'Against' } : l === 'es' ? { a: 'A favor', b: 'En contra' } : { a: 'За', b: 'Против' };

// Safe fallback topics if the model's topic keeps getting blocked / model is down.
const FALLBACK: Record<string, string[]> = {
  ru: ['Удалённая работа эффективнее офиса', 'Соцсети приносят больше вреда, чем пользы',
       'Школьная форма нужна', 'Четырёхдневная рабочая неделя — это будущее'],
  en: ['Remote work beats the office', 'Social media does more harm than good',
       'School uniforms should be mandatory', 'The four-day work week is the future'],
  es: ['El teletrabajo supera a la oficina', 'Las redes sociales hacen más mal que bien',
       'El uniforme escolar debería ser obligatorio', 'La semana laboral de cuatro días es el futuro'],
};

export const coachRouter = Router();

function requireUser(req: Request, res: Response): string | null {
  const uid = getUserIdFromReq(req);
  if (!uid) { res.status(401).json({ error: 'sign in to use the coach' }); return null; }
  if (!coachEnabled()) { res.status(501).json({ error: 'coach not configured' }); return null; }
  return uid;
}

type HistItem = { role: 'human' | 'ai'; text: string };
const cleanHistory = (h: unknown): HistItem[] =>
  Array.isArray(h)
    ? h.filter((m: any) => (m?.role === 'human' || m?.role === 'ai') && typeof m?.text === 'string')
        .slice(-24)
        .map((m: any) => ({ role: m.role, text: String(m.text).slice(0, 2000) }))
    : [];

// POST /start { rounds, lang } -> { topic, sideA, sideB, humanSide, aiSide }
coachRouter.post('/start', async (req: Request, res: Response): Promise<void> => {
  const uid = requireUser(req, res);
  if (!uid) return;
  const lang = ['ru', 'en', 'es'].includes(String(req.body?.lang)) ? String(req.body.lang) : 'ru';
  const labels = sideLabels(lang);
  try {
    let topic = '';
    for (let attempt = 0; attempt < 3 && !topic; attempt++) {
      const raw = await callDeepSeek(
        [
          { role: 'system', content:
            `Ты придумываешь тему для тренировочного дебата. Придумай ОДНУ острую, но корректную тему на ${langName(lang)} языке: ` +
            `спорную, с двумя ясными сторонами «за/против», подходящую для тренировки аргументации. ` +
            `СТРОГО избегай политики, выборов, конфликтов, религиозной розни, разжигания ненависти, вреда, а также тем, ограниченных законодательством РФ. ` +
            `Бери бытовые/общественные/культурные/научно-популярные темы. Тема — одно утверждение (не вопрос). ` +
            `Верни JSON: {"topic":"..."}.` },
          { role: 'user', content: 'Придумай новую тему для дебата.' },
        ],
        { json: true, temp: 1.0, maxTokens: 120 }
      );
      let cand = '';
      try { cand = String(JSON.parse(raw).topic || '').trim(); } catch { cand = ''; }
      if (!cand) continue;
      const v = await moderate({ kind: 'topic', lang, title: cand, sideA: labels.a, sideB: labels.b } as any, uid);
      if (v.verdict !== 'block') topic = cand;
    }
    if (!topic) {
      const list = FALLBACK[lang] || FALLBACK.ru;
      topic = list[Math.floor(Math.random() * list.length)];
    }
    const humanSide = Math.random() < 0.5 ? 'A' : 'B';
    res.json({
      topic,
      sideA: labels.a,
      sideB: labels.b,
      humanSide,
      aiSide: humanSide === 'A' ? 'B' : 'A',
    });
  } catch (e) {
    console.error('coach start error:', e);
    res.status(500).json({ error: 'failed to start' });
  }
});

// POST /reply { topic, sideA, sideB, humanSide, aiSide, round, rounds, lang, history } -> { reply }
coachRouter.post('/reply', async (req: Request, res: Response): Promise<void> => {
  const uid = requireUser(req, res);
  if (!uid) return;
  const b = req.body || {};
  const lang = ['ru', 'en', 'es'].includes(String(b.lang)) ? String(b.lang) : 'ru';
  const labels = sideLabels(lang);
  const topic = String(b.topic || '').slice(0, 300);
  const humanSide = b.humanSide === 'B' ? 'B' : 'A';
  const aiSide = humanSide === 'A' ? 'B' : 'A';
  const aiLabel = aiSide === 'A' ? labels.a : labels.b;
  const humanLabel = humanSide === 'A' ? labels.a : labels.b;
  const round = Math.max(1, Math.min(10, parseInt(String(b.round || 1), 10) || 1));
  const rounds = Math.max(1, Math.min(10, parseInt(String(b.rounds || 3), 10) || 3));
  const history = cleanHistory(b.history);
  if (!topic) { res.status(400).json({ error: 'topic required' }); return; }
  try {
    const system =
      `Ты — опытный оппонент в учебном дебате. Тема: «${topic}». ` +
      `Ты защищаешь позицию «${aiLabel}». Человек защищает «${humanLabel}». Сейчас раунд ${round} из ${rounds}. ` +
      `Ответь на последнюю реплику человека: сначала коротко контратакуй его главный довод, затем приведи один свой сильный аргумент с примером. ` +
      `2–4 предложения, живо и по делу, без воды и без списков. Пиши на ${langName(lang)} языке. ` +
      `Оставайся в роли оппонента, не подыгрывай и не выходи из дебата, не давай оценок выступлению (разбор будет в конце).`;
    const messages: Msg[] = [{ role: 'system', content: system }];
    for (const m of history) messages.push({ role: m.role === 'human' ? 'user' : 'assistant', content: m.text });
    if (messages[messages.length - 1]?.role !== 'user') {
      messages.push({ role: 'user', content: '(собеседник промолчал — продолжай дебат своим аргументом)' });
    }
    const reply = (await callDeepSeek(messages, { temp: 0.85, maxTokens: 260 })).trim();
    res.json({ reply });
  } catch (e) {
    console.error('coach reply error:', e);
    res.status(500).json({ error: 'failed to reply' });
  }
});

// POST /review { topic, humanSide, sideA, sideB, lang, history } -> { score, summary, strengths[], mistakes[], tips[] }
coachRouter.post('/review', async (req: Request, res: Response): Promise<void> => {
  const uid = requireUser(req, res);
  if (!uid) return;
  const b = req.body || {};
  const lang = ['ru', 'en', 'es'].includes(String(b.lang)) ? String(b.lang) : 'ru';
  const labels = sideLabels(lang);
  const topic = String(b.topic || '').slice(0, 300);
  const humanSide = b.humanSide === 'B' ? 'B' : 'A';
  const humanLabel = humanSide === 'A' ? labels.a : labels.b;
  const history = cleanHistory(b.history);
  const transcript = history
    .map((m) => `${m.role === 'human' ? 'ЧЕЛОВЕК' : 'ОППОНЕНТ'}: ${m.text}`)
    .join('\n');
  try {
    const raw = await callDeepSeek(
      [
        { role: 'system', content:
          `Ты — строгий, но доброжелательный тренер по дебатам. Разбери выступление ЧЕЛОВЕКА (он защищал позицию «${humanLabel}» по теме «${topic}») ` +
          `с точки зрения методологии дебатов: структура (тезис–довод–пример–вывод), логика (подмена понятий, ad hominem, соломенное чучело, обобщения), ` +
          `работа с аргументами оппонента (отвечал ли, или игнорировал), убедительность и примеры. ` +
          `Оценивай ТОЛЬКО реплики человека, не оппонента. Будь конкретен, ссылайся на то, что он реально писал. Пиши на ${langName(lang)} языке. ` +
          `Верни СТРОГО JSON: {"score": число 1-10, "summary":"1-2 предложения итог", "strengths":["..."], "mistakes":["..."], "tips":["3 конкретных совета"]}.` },
        { role: 'user', content: `Стенограмма дебата:\n${transcript || '(человек почти ничего не сказал)'}` },
      ],
      { json: true, temp: 0.5, maxTokens: 700 }
    );
    let out: any = {};
    try { out = JSON.parse(raw); } catch { out = {}; }
    const arr = (x: any) => (Array.isArray(x) ? x.map(String).slice(0, 6) : []);
    res.json({
      score: Math.max(1, Math.min(10, Number(out.score) || 5)),
      summary: String(out.summary || '').slice(0, 500),
      strengths: arr(out.strengths),
      mistakes: arr(out.mistakes),
      tips: arr(out.tips),
    });
  } catch (e) {
    console.error('coach review error:', e);
    res.status(500).json({ error: 'failed to review' });
  }
});
