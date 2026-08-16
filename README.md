# shelfmark-worker

Cloudflare Worker backing [Shelfmark](https://github.com/simonkurth-lab/Shelfmark). Proxies the
Anthropic API for book leveling + quiz generation, and stores student/book data in Workers KV.

Deployed at `https://shelfmark-api.simonkurth.workers.dev`. This repo was extracted from the live
worker (previously edited only in the Cloudflare dashboard) so it can be version controlled.

## Setup

```bash
npm install
wrangler login
```

Fill in `wrangler.toml` with your existing KV namespace ID:

```bash
wrangler kv namespace list
```

Set the Anthropic API key as a secret (do not put it in wrangler.toml or commit it):

```bash
wrangler secret put ANTHROPIC_API_KEY
```

For local dev, copy `.dev.vars.example` to `.dev.vars` and fill in the real key (`.dev.vars` is
gitignored).

## Develop / deploy

```bash
npm run dev      # local dev server
npm run deploy   # publish to shelfmark-api.simonkurth.workers.dev
npm run tail     # stream live logs
```

## API

- `POST /api/book-meta` — `{olid, title, author, year, description}` → cached `{gradeLevel, summary, genre}`
- `POST /api/quiz` — `{olid, title, author, summary, gradeLevel, count}` (`count` is `5`, `7`, or `10`, defaults to `5`) → cached `{questions: [{q, options, correctIndex}]}`, cached per `olid` + `count`
- `GET  /api/student/:name` / `POST /api/student/:name` — read/write a student record
- `GET  /api/roster` — list all student records
