<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Project structure
Three independent folders, no root `package.json`/workspace — each has its own lockfile; run all commands from inside `frontend/` or `backend/`, not the repo root.
- `frontend/` — Next.js 16 (TypeScript) web app ("Cuneihire", formerly "Viddr"/"AutoMailSend"), SPA-style catch-all route at `src/app/[[...tab]]/page.tsx`
- `backend/` — Node.js (CommonJS) worker/scheduler: BullMQ queues + Redis, polls Supabase, no HTTP server. Deployed via PM2 on a remote host over SSH.
- `extension/` — Chrome MV3 extension (plain JS) that extracts a LinkedIn `JSESSIONID` cookie for the app

## Commands
- Frontend (from `frontend/`): `npm run dev`, `npm run build`, `npm run lint` (no test script)
- Backend (from `backend/`): `npm run dev` (nodemon), `npm run trigger` (manual one-off run via `trigger.js`), `npm run dev:all` (runs backend + frontend concurrently). `npm test` is a placeholder — no tests exist anywhere in this repo.
- `frontend/.npmrc` sets `legacy-peer-deps=true` — required for `npm install` to succeed there.

## Data & auth
- Supabase Auth (email/password, RLS keyed on `auth.users`) and Supabase Postgres for data — no ORM, no migration tool. Schema lives in `frontend/database/supabase_setup.sql` and `backend/database/supabase_setup.sql` — as of 2026-08-17 these two are byte-identical and match the live schema (a fresh Supabase project); re-run the whole file (idempotent) rather than hand-editing just one copy, and keep them mirrored.
- Secrets (`ENCRYPTION_KEY`, Supabase service role key, Redis URL, etc.) come from environment variables. `backend/.env` and `frontend/.env.local` hold this project's actual Supabase credentials (gitignored, not in the global `~/.claude/secrets/credentials.env` — that file's own header says not to auto-save operator tokens there since the account is shared). `ENCRYPTION_KEY` and Redis are not yet set locally — ask before assuming a var's name or value.

## Deploy gotcha
Pushing to `master`/`main` with changes under `backend/**` auto-deploys to production (`.github/workflows/backend-deploy.yml` SSHs in, runs `npm i`, `pm2 restart auto_apply_linkedin_backend`) — there is no test or lint gate in that pipeline, so backend changes reach prod as soon as they land on the default branch.

## Context docs
Read on demand, not eagerly — each covers one concern:
- `docs/project-requirement.md` — what this product is, who it's for, what success looks like
- `docs/architecture.md` — how frontend/backend/extension fit together and how data flows
- `docs/structure.md` — folder/module layout, what lives where
- `docs/rules.md` — engineering & security guardrails (secrets, ship discipline, this repo's gotchas)
- `docs/design.md` — product/UX principles and this app's flow
- `docs/role.md` — the admin/user access model and how it's enforced
- `docs/tools.md` — infra/integrations this project actually uses
- `docs/memory.md` — living hand-off notes; read first when resuming work, update every phase
