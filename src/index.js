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
const GRADE_LABELS = {
  k2: 'kindergarten through 2nd grade (ages 5-8)',
  '35': '3rd through 5th grade (ages 8-11)',
  '68': '6th through 8th grade (ages 11-14)',
  '912': '9th through 12th grade (ages 14-18)',
};
const GRADE_VOCAB_GUIDANCE = {
  k2: 'Use very short sentences (about 5-8 words each), only the simplest everyday words a 5-8 year old already knows, and no compound or multi-clause sentences.',
  '35': 'This is elementary school, not middle school - calibrate carefully. Use short, plain sentences (roughly 8-14 words). Use only everyday words a typical 9-11 year old reads independently: say "showed" not "demonstrated," "found out" not "discovered," "because" not "consequently," "scared" not "apprehensive." Avoid academic, abstract, or multisyllabic vocabulary and avoid sentences with multiple clauses or semicolons. Match the reading level of a Magic Tree House or Diary of a Wimpy Kid book, not a textbook or news article.',
  '68': 'Use clear, moderate-length sentences and common middle-school vocabulary. Some richer words are fine, but avoid academic or technical vocabulary unless its meaning is obvious from context.',
  '912': 'Standard high-school reading level - full vocabulary range is fine, but keep sentences clear rather than needlessly dense.',
};
const CHALLENGE_LABELS = {
  easier: 'a bit easier than that grade level - use simpler vocabulary, more straightforward sentence structure, and make the wrong answer choices clearly distinguishable',
  onlevel: 'right at that grade level in vocabulary and sentence complexity',
  harder: 'a bit more challenging than that grade level - use richer vocabulary and make the wrong answer choices more subtly similar to the correct one',
};

// Cost circuit breaker: caps real Claude API calls (cache hits don't count) per day,
// so a script hammering the public book-meta/quiz endpoints with unique fake inputs
// can't run up an unbounded bill.
const DAILY_CLAUDE_CALL_LIMIT = 300;

async function tryConsumeDailyClaudeCall(env) {
  const today = new Date().toISOString().slice(0, 10);
  const key = 'usage:' + today;
  const current = parseInt((await env.SHELFMARK_KV.get(key)) || '0', 10);
  if (current >= DAILY_CLAUDE_CALL_LIMIT) return false;
  await env.SHELFMARK_KV.put(key, String(current + 1), { expirationTtl: 172800 });
  return true;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

const DEFAULT_CLASS = 'default';

function cleanClassCode(classCode) {
  const cleaned = (classCode || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40);
  return cleaned || DEFAULT_CLASS;
}

// Scoping the key by class lets two students in different classes share the
// same alias - only alias + class together need to be unique.
function studentKey(alias, classCode) {
  return 'student:' + cleanClassCode(classCode) + ':' + alias.trim().toLowerCase();
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
          if (!(await tryConsumeDailyClaudeCall(env))) throw new Error('daily_limit_reached');
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
        const { olid, title, author, summary, count, grade, challenge, bilingual } = await request.json();
        const questionCount = QUIZ_LENGTHS.includes(Number(count)) ? Number(count) : DEFAULT_QUIZ_LENGTH;
        const gradeKey = GRADE_LABELS[grade] ? grade : '35';
        const challengeKey = CHALLENGE_LABELS[challenge] ? challenge : 'onlevel';
        const bilingualKey = bilingual ? 'bi' : 'en';
        const cacheKey = `quiz:v2:${olid}:${questionCount}:${gradeKey}:${challengeKey}:${bilingualKey}`;
        const cached = await env.SHELFMARK_KV.get(cacheKey);
        if (cached) return json(JSON.parse(cached));

        const formatBlock = bilingualKey === 'bi'
          ? `For EVERY question and EVERY answer choice, provide both an English version and a natural (not word-for-word) Spanish version at the same grade level. Respond with ONLY raw JSON, no markdown:
{"questions":[{"q":"English question", "q_es":"Spanish question", "options":["English A","English B","English C","English D"], "options_es":["Spanish A","Spanish B","Spanish C","Spanish D"], "correctIndex":0}, ...]}`
          : `Write the quiz in English. Respond with ONLY raw JSON, no markdown:
{"questions":[{"q":"...", "options":["...","...","...","..."], "correctIndex":0}, ...]}`;

        const prompt = `Book: "${title}" by ${author}. Summary: ${summary}

Write ${questionCount} multiple-choice comprehension questions for a student in ${GRADE_LABELS[gradeKey]} who just finished reading this book. ${GRADE_VOCAB_GUIDANCE[gradeKey]} Within that reading level, make the questions and answer choices ${CHALLENGE_LABELS[challengeKey]}. Keep questions broad and generic (main character, setting, general plot shape) rather than hyper-specific, especially since exact book details may not be fully known. Mix plot, character, and detail questions. ${formatBlock}`;

        let quiz;
        try {
          if (!(await tryConsumeDailyClaudeCall(env))) throw new Error('daily_limit_reached');
          const raw = await callClaude(
            env,
            prompt,
            'You write short, clear, generic-is-fine comprehension quizzes calibrated to a specific school grade level. Always respond with only valid JSON.'
          );
          quiz = parseJsonLoose(raw);
        } catch (e) {
          quiz = { questions: [{ q: 'Quiz could not be generated. Try again?', options: ['OK'], correctIndex: 0 }] };
        }
        await env.SHELFMARK_KV.put(cacheKey, JSON.stringify(quiz));
        return json(quiz);
      }

      // ---- Signup: create a new alias + PIN (scoped to a class) ----
      if (path === '/api/signup' && request.method === 'POST') {
        const { alias, pin, grade, classCode } = await request.json();
        const cleanAlias = (alias || '').trim();
        if (!cleanAlias || cleanAlias.length > 24) return json({ error: 'invalid_alias' }, 400);
        if (!PIN_RE.test(pin || '')) return json({ error: 'invalid_pin' }, 400);

        const cleanClass = cleanClassCode(classCode);
        const key = studentKey(cleanAlias, cleanClass);
        const existing = await env.SHELFMARK_KV.get(key);
        if (existing) return json({ error: 'alias_taken' }, 409);

        const cleanGrade = GRADE_LABELS[grade] ? grade : '35';
        const record = { alias: cleanAlias, pin, grade: cleanGrade, classCode: cleanClass, points: 0, history: [] };
        await env.SHELFMARK_KV.put(key, JSON.stringify(record));
        const { pin: _pin, ...safe } = record;
        return json(safe);
      }

      // ---- Login: verify PIN, return student record (never the pin) ----
      if (path === '/api/login' && request.method === 'POST') {
        const { alias, pin, classCode } = await request.json();
        const cleanAlias = (alias || '').trim();
        const key = studentKey(cleanAlias, classCode);
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
        const key = studentKey(alias, url.searchParams.get('class'));
        const body = await request.json();
        const existingRaw = await env.SHELFMARK_KV.get(key);
        if (!existingRaw) return json({ error: 'not_found' }, 404);
        const existing = JSON.parse(existingRaw);
        const merged = { ...existing, ...body, pin: existing.pin, alias: existing.alias, classCode: existing.classCode };
        await env.SHELFMARK_KV.put(key, JSON.stringify(merged));
        return json({ ok: true });
      }

      // ---- Public roster (login screen): alias + points + book count only, never the pin ----
      // Scoped to one class so kids in a different period don't see each other's aliases.
      if (path === '/api/roster' && request.method === 'GET') {
        const cleanClass = cleanClassCode(url.searchParams.get('class'));
        const list = await env.SHELFMARK_KV.list({ prefix: 'student:' + cleanClass + ':' });
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

      // ---- Teacher passcode check only (no data returned) - used to unlock
      // the daily reading-word-count limit without fetching the full roster ----
      if (path === '/api/teacher/verify' && request.method === 'POST') {
        const { passcode } = await request.json();
        const ok = !!env.TEACHER_PASSCODE && passcode === env.TEACHER_PASSCODE;
        return json({ ok });
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

      // ---- Teacher: delete one quiz attempt from a student's history ----
      // Recomputes points/wordsRead from the remaining history rather than
      // subtracting, so there's no risk of drift if records are ever edited
      // out of band.
      if (path === '/api/teacher/delete-attempt' && request.method === 'POST') {
        const { passcode, alias, classCode, index } = await request.json();
        if (!env.TEACHER_PASSCODE || passcode !== env.TEACHER_PASSCODE) {
          return json({ error: 'unauthorized' }, 401);
        }
        const key = studentKey(alias || '', classCode);
        const raw = await env.SHELFMARK_KV.get(key);
        if (!raw) return json({ error: 'not_found' }, 404);
        const record = JSON.parse(raw);
        const hist = record.history || [];
        const i = Number(index);
        if (!Number.isInteger(i) || i < 0 || i >= hist.length) return json({ error: 'invalid_index' }, 400);
        hist.splice(i, 1);
        record.history = hist;
        record.points = hist.reduce((sum, h) => sum + (h.points || 0), 0);
        record.wordsRead = hist.reduce((sum, h) => sum + (h.words || 0), 0);
        await env.SHELFMARK_KV.put(key, JSON.stringify(record));
        return json(record);
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
};
