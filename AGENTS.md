<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# SOP Software — Agent Instructions

Shared instructions for **Claude Code** (`CLAUDE.md` → this file) and **OpenAI Codex** (`CODEX.md` → this file). Keep changes minimal and match existing patterns.

## Project

Pharma SOP management platform: SOP registry/upload, MCQ bank generation for LMS training, compliance auditing against regulatory guidelines (ICH, EU-GMP, WHO, PIC/S), and training-matrix workflows.

**Stack:** Next.js 16 (App Router), React 19, TypeScript, MongoDB (Mongoose), NextAuth, Tailwind CSS 4, Bunny CDN, Gemini / Claude / Ollama for LLM tasks.

## Commands

```bash
npm run dev          # Start dev server (kills stale port, default :3000) + local Codex MCQ worker
npm run dev:clean    # Delete .next then start
npm run mcq:worker   # Poll production MongoDB for queued Codex MCQ jobs and generate them locally
npm run build        # Production build
npm run start        # Production server
npm run lint         # ESLint
npm run seed:admin   # Seed admin user
```

**Diagnostics:** `npx tsx scripts/diag-mcqgen.ts`, `npx tsx scripts/stop-mcq-gen.ts` (force-stop MCQ jobs + CLI subprocesses).

Copy `.env.example` → `.env.local` before running. Required: `MONGODB_URI`.

**Production Codex MCQs:** Vercel cannot run the Codex CLI. SOP uploads enqueue `MCQGenJob` with `awaitingLocalWorker: true`. Point local `.env.local` at the **same** `MONGODB_URI` as production, keep `npm run dev` or `npm run mcq:worker` running (`codex login`), and the worker claims those jobs.

## Architecture

| Area | Path | Notes |
|------|------|-------|
| API routes | `app/api/` | App Router handlers |
| Business logic | `lib/` | LLM, MCQ, compliance, SOP upload, caches |
| Models | `models/` | Mongoose schemas |
| UI | `components/`, `app/**/page.tsx` | Dashboard, MCQ bank, LMS, compliance |
| Scripts | `scripts/` | Dev server, diagnostics, seeds |
| Agent memory | `memory/` | Project notes (e.g. cache invalidation) |

Path alias: `@/*` → project root.

## MCQ generation pipeline

End-to-end flow (do not change business logic without good reason):

1. **Enqueue** — `lib/mcq-generation.ts` → `enqueueMcqGeneration` creates `MCQGenJob` in MongoDB.
2. **Run** — `runMcqGeneration` per language (ENG/GUJ): pick best SOP text, build clause index (`lib/mcq-clauses.ts`, `lib/mcq-clause-cache.ts`).
3. **Generate** — `callMcqModel` routes to Claude API/CLI, Gemini, or Ollama (`lib/llm.ts`). Fast-fill excerpt batches (`lib/mcq-generation-config.ts`) or clause-wise phase.
4. **Post-process** — JSON parse (`lib/mcq-json-parse.ts`), dedup (`lib/similarity.ts`), max 1 MCQ/clause, bank cap 100 (`lib/mcq-bank-write.ts`).
5. **Track** — Job store (`lib/mcq-gen-job-store.ts`); client polls `/api/sop/generate-mcqs/status`.
6. **Cancel** — `lib/mcq-run-control.ts` aborts in-process runs and kills CLI subprocesses.

**MCQ JSON schema** (must preserve):

```json
{"questions":[{"question":"string","optionA":"string","optionB":"string","optionC":"string","optionD":"string","correctAnswer":"A","difficulty":"easy|medium|hard","sopReference":"clause-id"}]}
```

`correctAnswer` is a single letter A–D. `sopReference` = bracketed clause id from SOP text.

## Runtime LLM providers (application)

Separate from which **coding agent** you use. Configured via `.env.local`:

| Variable | Role | Default |
|----------|------|---------|
| `LLM_PROVIDER` | MCQ generation | `claude` |
| `LLM_COMPLIANCE_PROVIDER` | Compliance analysis | `gemini` |
| `GEMINI_API_KEY` | Gemini API | required when compliance/MCQ uses gemini |
| `ANTHROPIC_API_KEY` | Direct Anthropic API for MCQ (faster than CLI) | optional |
| `MCQ_CODEX_MODEL` | Codex MCQ model (ChatGPT subscription) | `gpt-5.4-mini` |
| `OLLAMA_BASE_URL` | Local Ollama | `http://localhost:11434` |

Router: `lib/llm.ts`. Claude CLI: `lib/claude-cli.ts`. Codex CLI: `lib/codex-cli.ts`. Anthropic MCQ batches: `lib/anthropic-mcq.ts`. Gemini: `lib/gemini-client.ts`.

When `ANTHROPIC_API_KEY` is set, MCQ uses the API and does **not** require the `claude` CLI. Codex MCQ uses `codex exec` with your ChatGPT login — no OpenAI API key.

## Coding rules

1. **Minimize scope** — Smallest correct diff; no drive-by refactors.
2. **Match conventions** — Read surrounding code; reuse existing helpers.
3. **Cache invalidation** — Any SOP mutation must call `invalidateDashboardSopsCache()` (`lib/server-cache.ts`), which busts derived caches via `invalidateSopDerivedCaches()` (`lib/sopCacheInvalidation.ts`). New SOP-derived caches must wire into that function.
4. **Auth** — Use `withAuth` / role checks on API routes; do not bypass.
5. **No secrets in git** — `.env.local` is gitignored; document vars in `.env.example` only.
6. **Tests** — Only add when requested or they cover real behavior.

## AI coding agents (development)

| Tool | Entry file | Setup |
|------|------------|-------|
| Claude Code | `CLAUDE.md` | `claude auth login`; reads `AGENTS.md` via include |
| OpenAI Codex | `CODEX.md` | Reads `AGENTS.md` from repo root; optional `~/.codex/AGENTS.md` for global prefs |

Both agents share this file. For Codex fallback filenames (e.g. `CLAUDE.md`), see `docs/codex-setup.md`.

Do not add tool-specific logic to application code unless it is a runtime LLM provider integration.
