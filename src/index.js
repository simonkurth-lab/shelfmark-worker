// Shelfmark API Worker
// Handles: Claude API proxy (book leveling + quiz generation) and KV-based student/book storage.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const QUIZ_LENGTHS = [5, 7, 10];
const DEFAULT_QUIZ_LENGTH = 5;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
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
        const cacheKey = 'book:' + olid;
        const cached = await env.SHELFMARK_KV.get(cacheKey);
        if (cached) return json(JSON.parse(cached));

        const prompt = `Book: "${title}" by ${author}${year ? ' (' + year + ')' : ''}.
${description ? 'Description: ' + description.slice(0, 600) : 'No description available - use your knowledge of this book.'}

Respond with ONLY raw JSON, no markdown, in this exact shape:
{"gradeLevel": <number, US grade-level reading estimate e.g. 4.5>, "summary": "<2-3 sentence plot summary suitable for a 10-11 year old, no spoilers of the ending>", "genre": "<short genre label>"}`;

        let meta;
        try {
          const raw = await callClaude(
            env,
            prompt,
            "You are a children's literature specialist helping a 5th grade teacher estimate reading levels and write short summaries. Always respond with only valid JSON, nothing else."
          );
          meta = parseJsonLoose(raw);
        } catch (e) {
          meta = { gradeLevel: 4.5, summary: description ? description.slice(0, 220) : 'Summary unavailable.', genre: 'Fiction' };
        }
        await env.SHELFMARK_KV.put(cacheKey, JSON.stringify(meta));
        return json(meta);
      }

      // ---- Quiz generation (cached in KV, keyed per book + question count) ----
      if (path === '/api/quiz' && request.method === 'POST') {
        const { olid, title, author, summary, gradeLevel, count } = await request.json();
        const questionCount = QUIZ_LENGTHS.includes(Number(count)) ? Number(count) : DEFAULT_QUIZ_LENGTH;
        const cacheKey = `quiz:${olid}:${questionCount}`;
        const cached = await env.SHELFMARK_KV.get(cacheKey);
        if (cached) return json(JSON.parse(cached));

        const prompt = `Book: "${title}" by ${author}. Summary: ${summary}

Write ${questionCount} multiple-choice comprehension questions for a student who just finished reading this book, appropriate for reading level ${Number(gradeLevel).toFixed(1)}. Keep questions broad and generic (main character, setting, general plot shape) rather than hyper-specific, especially since exact book details may not be fully known. Mix plot, character, and detail questions. Respond with ONLY raw JSON, no markdown:
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

      // ---- Student data ----
      if (path.startsWith('/api/student/') && request.method === 'GET') {
        const name = decodeURIComponent(path.replace('/api/student/', ''));
        const data = await env.SHELFMARK_KV.get('student:' + name.toLowerCase());
        return json(data ? JSON.parse(data) : null);
      }

      if (path.startsWith('/api/student/') && request.method === 'POST') {
        const name = decodeURIComponent(path.replace('/api/student/', ''));
        const body = await request.json();
        await env.SHELFMARK_KV.put('student:' + name.toLowerCase(), JSON.stringify(body));
        return json({ ok: true });
      }

      // ---- Roster (teacher dashboard) ----
      if (path === '/api/roster' && request.method === 'GET') {
        const list = await env.SHELFMARK_KV.list({ prefix: 'student:' });
        const students = [];
        for (const key of list.keys) {
          const val = await env.SHELFMARK_KV.get(key.name);
          if (val) students.push(JSON.parse(val));
        }
        return json(students);
      }

      return json({ error: 'Not found' }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
};
