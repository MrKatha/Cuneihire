# Tools (capabilities & infra)

> Global seed below, unedited — this project's actual integrations follow under "This project."

## Standard infrastructure (the operator's common stack)
- **DigitalOcean droplet** (FRA1) — always-on host.
- **n8n** (Docker, `n8n.mrkatha.info`) — workflow automation.
- **Supabase** — Postgres store + Auth. Management API for migrations; service-role key is deny-all-table only.
- **Vercel** — hosting/deploys; the preview build is the authoritative gate.
- **Telegram** — messaging / verification flows.
- **Resend** (via nodemailer SMTP relay) — transactional/campaign email.

## Global skills & plugins
Listed in `~/.claude/CLAUDE.md` → **Global inventory** (verify-payments, context-docs; n8n-skills, playwright,
skill-creator, frontend-design, vercel-plugin). Prefer a **skill over an MCP**; **webhooks/REST over an MCP** for
acting on external systems.

## Credentials
All keys live in `~/.claude/secrets/credentials.env` (single source of truth; never committed). Read from there;
copy only what a project needs into its gitignored `.env.local`.

## This project
- **Supabase** — project ref `nqdujjpnanlueddgqvxj` (Cuneihire, formerly AutoMailSend/Viddr — a *different* Supabase project from
  the "UMS project" bare `SUPABASE_*` entry in the global credentials file; do not conflate the two). Auth +
  Postgres for both `frontend/` and `backend/`; no ORM, no migration tool (raw SQL, see
  [structure.md](structure.md)/[architecture.md](architecture.md)). Credentials live in this project's own
  gitignored `backend/.env` and `frontend/.env.local` (added 2026-08-17), **not** the global credentials file —
  that file's own header says not to auto-save operator-provided tokens there. `backend/.env` also holds
  `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` for running schema changes via the Management API
  (`https://api.supabase.com/v1/projects/{ref}/database/query`), and a `SUPABASE_DB_URL` session-pooler
  connection string as a fallback. Backend prefers the service-role key over anon (falls back with a warning,
  since RLS would otherwise block backend access) — this differs from the seed's "deny-all-table only" service
  role assumption; this project's service-role key does bypass RLS normally.
- **Redis + BullMQ** — backend job queues (`automail`, `batchSend`, `scraper`), configured via `REDIS_URL`.
- **Nodemailer** — actual SMTP sending, both from the frontend (`/api/send`) and backend workers, using each
  user's own SMTP credentials (Gmail app password is the documented path in the README).
- **AI personalization — Google Gemini, platform-managed (2026-08-18).** Used to be per-user BYOK across
  Groq/OpenAI/Gemini; now the platform runs its own enterprise `GEMINI_API_KEY` server-side (a dedicated
  key, deliberately separate from the operator's other shared Gemini key in the global credentials file)
  and users spend from an admin-granted credit balance instead. **Required in two separate places** — the
  backend workers (`backend/.env`) and the Next.js AI routes on the Vercel-hosted frontend
  (`frontend/.env.local` locally, the Vercel project's env vars in production) — these are two different
  deployments that both call Gemini directly. Base URL override via `GEMINI_API_URL` if ever needed. See
  `backend/src/services/ai.service.js`, `frontend/src/lib/aiClient.ts`,
  `backend/src/lib/aiCredits.js`, and docs/architecture.md.
- **PM2** — backend process manager on a remote host, deployed via SSH from CI on push to `master`/`main`
  touching `backend/**` (`.github/workflows/backend-deploy.yml`) — no test/lint gate.
- **Hosting target: AWS (operator directive, 2026-08-17)** — this project deploys to AWS, overriding the
  operator's usual DigitalOcean+Vercel default stack from the seed above (a per-project override, not a
  change to that global default — see `~/.claude/CLAUDE.md`'s own convention on this). Specific AWS
  services/account not yet given — ask before assuming EC2 vs ECS vs Amplify/Elastic Beanstalk, or before
  wiring anything AWS-specific (IAM, S3, Secrets Manager, etc.). Until specifics are known: avoid
  Vercel-specific conventions (edge functions, `vercel.json`) and don't assume the current PM2/SSH backend
  host above is or isn't already on AWS.
- **n8n / Telegram / Resend** from the seed above are not used in this project.
