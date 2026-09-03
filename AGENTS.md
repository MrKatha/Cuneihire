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
`.github/workflows/backend-deploy.yml` SSHs in, `git pull`, `npm i`, `pm2 restart auto_apply_linkedin_backend --update-env`, no test/lint gate. Secrets `SERVER_IP`/`SERVER_USER`/`SERVER_PORT`/`SERVER_PRIVATE_KEY` are set on the repo (the old `SERVER_ROOT_PASSWORD`/`sudo` wrapper was dropped 2026-08-28 as unnecessary — every manual deploy this whole project ran fine as the plain `ubuntu` user). `gh` note: this repo needs the `MrKatha` GitHub account, not `sohaib-axionai` — `gh auth switch --hostname github.com --user MrKatha` if `gh secret set`/similar 403s with "repository secrets fine-grained permission."

**`push`-triggered auto-deploy is confirmed WORKING again as of 2026-09-03** (`gh run list --workflow=backend-deploy.yml` showed a `push`-triggered run auto-fire and succeed immediately after a real push touching `backend/**`, alongside a manual `workflow_dispatch` run for the same commit — both completed successfully). This reverses the 2026-08-28 finding below, which is kept for history/root-cause context only — something (likely the one-time Settings → Actions → General click that finding called out as the fix, or a GitHub-side change to fork defaults) resolved it between 2026-08-28 and 2026-09-03; exactly when/how wasn't caught live. **Don't assume manual deploy is still required — check `gh run list --workflow=backend-deploy.yml --limit 3` for a recent `push`-triggered `success` before falling back to a manual trigger.** The manual path still works as a fallback: `gh workflow run backend-deploy.yml --ref master`, or the SSH fallback: `git pull && npm i && pm2 restart auto_apply_linkedin_backend --update-env`.

<details><summary>2026-08-28 finding (historical, superseded above)</summary>

`push`-triggered auto-deploy did NOT fire — confirmed by polling the Actions API after a real push touching `backend/**`: 0 push-triggered runs, ever (only 2 manual `workflow_dispatch` runs existed in the repo's whole history at the time). Root cause: `MrKatha/Cuneihire` is a **fork** of `IsmailofficialGithub/Bulk_email_by_role` (`gh api repos/MrKatha/Cuneihire --jq .fork` → `true`) — forked repos need auto-triggered workflows (push/schedule) separately enabled in the GitHub web UI (Settings → Actions → General) even after Actions is otherwise "enabled" for manual dispatch.

</details>

## Context docs
Read on demand, not eagerly — each covers one concern:
- `docs/project-requirement.md` — what this product is, who it's for, what success looks like
- `docs/architecture.md` — how frontend/backend/extension fit together and how data flows
- `docs/structure.md` — folder/module layout, what lives where
- `docs/rules.md` — engineering & security guardrails (secrets, ship discipline, this repo's gotchas)
- `docs/design.md` — product/UX principles and this app's flow
- `docs/role.md` — the admin/user access model and how it's enforced
- `docs/tools.md` — infra/integrations this project actually uses
- `docs/pricing-tiers.md` — candidate plan tiers spec (Free/Pro/Premium), the real admin-override levers they map onto, and gaps found while designing it
- `docs/memory.md` — living hand-off notes; read first when resuming work, update every phase
