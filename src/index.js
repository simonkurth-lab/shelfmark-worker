// Shelfmark API Worker
// Handles: Claude API proxy (book summaries + quiz generation) and KV-based student/book storage.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const QUIZ_LENGTHS = [5, 7, 10];
const DEFAULT_QUIZ_LENGTH = 5;
const PIN_RE = /^\d{4}$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function studentKey(alias) {
  return 'student:' + alias.trim().toLowerCase();
}

async function callClaude(env, prompt, system) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: system || undefined,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await resp.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  return textBlock ? textBlock.text : '';
}

function parseJsonLoose(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const objStart = cleaned.indexOf('{');
  const arrStart = cleaned.indexOf('[');
  let s = objStart;
  if (arrStart !== -1 && (s === -1 || arrStart < s)) s = arrStart;
  const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
  return JSON.parse(cleaned.slice(s, end + 1));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      // ---- Book metadata generation (cached in KV) ----
      if (path === '/api/book-meta' && request.method === 'POST') {
        const { olid, title, author, year, description } = await request.json();
        const cacheKey = 'book:v2:' + olid;
        const cached = await env.SHELFMARK_KV.get(cacheKey);
        if (cached) return json(JSON.parse(cached));

        const prompt = `Book: "${title}" by ${author}${year ? ' (' + year + ')' : ''}.
${description ? 'Description: ' + description.slice(0, 600) : 'No description available - use your knowledge of this book.'}

Respond with ONLY raw JSON, no markdown, in this exact shape:
{"summary": "<2-3 sentence plot summary suitable for a 10-11 year old, no spoilers of the ending>", "genre": "<short genre label>", "estimatedWordCount": <number, your best estimate of the TOTAL WORDS OF ACTUAL TEXT in this specific book, based on what you know of it - not a page-count formula. A heavily illustrated picture book might be only 200-800 words total even across 32-48 pages. A middle-grade novel might be 20,000-50,000 words. A longer novel could be 100,000+. Give your real best estimate for this exact book.>}`;

        let meta;
        try {
          const raw = await callClaude(
            env,
            prompt,
            "You are a children's literature specialist helping a 5th grade teacher write short book summaries and estimate actual text length. Always respond with only valid JSON, nothing else."
          );
          meta = parseJsonLoose(raw);
        } catch (e) {
          meta = { summary: description ? description.slice(0, 220) : 'Summary unavailable.', genre: 'Fiction', estimatedWordCount: null };
        }
        await env.SHELFMARK_KV.put(cacheKey, JSON.stringify(meta));
        return json(meta);
      }

      // ---- Quiz generation (cached in KV, keyed per book + question count) ----
      if (path === '/api/quiz' && request.method === 'POST') {
        const { olid, title, author, summary, count } = await request.json();
        const questionCount = QUIZ_LENGTHS.includes(Number(count)) ? Number(count) : DEFAULT_QUIZ_LENGTH;
        const cacheKey = `quiz:${olid}:${questionCount}`;
        const cached = await env.SHELFMARK_KV.get(cacheKey);
        if (cached) return json(JSON.parse(cached));

        const prompt = `Book: "${title}" by ${author}. Summary: ${summary}

Write ${questionCount} multiple-choice comprehension questions for a student who just finished reading this book, appropriate for a middle-grade reader (roughly ages 9-12). Keep questions broad and generic (main character, setting, general plot shape) rather than hyper-specific, especially since exact book details may not be fully known. Mix plot, character, and detail questions. Respond with ONLY raw JSON, no markdown:
{"questions":[{"q":"...", "options":["...","...","...","..."], "correctIndex":0}, ...]}`;

        let quiz;
        try {
          const raw = await callClaude(
            env,
            prompt,
            'You write short, clear, generic-is-fine comprehension quizzes for elementary readers. Always respond with only valid JSON.'
          );
          quiz = parseJsonLoose(raw);
        } catch (e) {
          quiz = { questions: [{ q: 'Quiz could not be generated. Try again?', options: ['OK'], correctIndex: 0 }] };
        }
        await env.SHELFMARK_KV.put(cacheKey, JSON.stringify(quiz));
        return json(quiz);
      }

      // ---- Signup: create a new alias + PIN ----
      if (path === '/api/signup' && request.method === 'POST') {
        const { alias, pin } = await request.json();
        const cleanAlias = (alias || '').trim();
        if (!cleanAlias || cleanAlias.length > 24) return json({ error: 'invalid_alias' }, 400);
        if (!PIN_RE.test(pin || '')) return json({ error: 'invalid_pin' }, 400);

        const key = studentKey(cleanAlias);
        const existing = await env.SHELFMARK_KV.get(key);
        if (existing) return json({ error: 'alias_taken' }, 409);

        const record = { alias: cleanAlias, pin, points: 0, history: [] };
        await env.SHELFMARK_KV.put(key, JSON.stringify(record));
        const { pin: _pin, ...safe } = record;
        return json(safe);
      }

      // ---- Login: verify PIN, return student record (never the pin) ----
      if (path === '/api/login' && request.method === 'POST') {
        const { alias, pin } = await request.json();
        const cleanAlias = (alias || '').trim();
        const key = studentKey(cleanAlias);
        const raw = await env.SHELFMARK_KV.get(key);
        if (!raw) return json({ error: 'not_found' }, 404);
        const record = JSON.parse(raw);
        if (record.pin !== pin) return json({ error: 'wrong_pin' }, 401);
        const { pin: _pin, ...safe } = record;
        return json(safe);
      }

      // ---- Student save (merges into existing record, preserves pin) ----
      if (path.startsWith('/api/student/') && request.method === 'POST') {
        const alias = decodeURIComponent(path.replace('/api/student/', ''));
        const key = studentKey(alias);
        const body = await request.json();
        const existingRaw = await env.SHELFMARK_KV.get(key);
        if (!existingRaw) return json({ error: 'not_found' }, 404);
        const existing = JSON.parse(existingRaw);
        const merged = { ...existing, ...body, pin: existing.pin, alias: existing.alias };
        await env.SHELFMARK_KV.put(key, JSON.stringify(merged));
        return json({ ok: true });
      }

      // ---- Public roster (login screen): alias + points + book count only, never the pin ----
      if (path === '/api/roster' && request.method === 'GET') {
        const list = await env.SHELFMARK_KV.list({ prefix: 'student:' });
        const students = [];
        for (const key of list.keys) {
          const val = await env.SHELFMARK_KV.get(key.name);
          if (val) {
            const s = JSON.parse(val);
            if (!s.alias) continue; // skip legacy pre-alias records
            students.push({ alias: s.alias, points: s.points || 0, books: (s.history || []).length });
          }
        }
        return json(students);
      }

      // ---- Teacher roster: full detail including PIN, gated by a separate passcode ----
      if (path === '/api/teacher/roster' && request.method === 'POST') {
        const { passcode } = await request.json();
        if (!env.TEACHER_PASSCODE || passcode !== env.TEACHER_PASSCODE) {
          return json({ error: 'unauthorized' }, 401);
        }
        const list = await env.SHELFMARK_KV.list({ prefix: 'student:' });
        const students = [];
        for (const key of list.keys) {
          const val = await env.SHELFMARK_KV.get(key.name);
          if (val) {
            const s = JSON.parse(val);
            if (!s.alias) continue; // skip legacy pre-alias records
            students.push(s);
          }
        }
        return json(students);
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
};
