# Rules (engineering & security guardrails)

> Global seed below, unedited — repo-specific rules follow under "This project." See `~/.claude/CLAUDE.md` for
> the self-improving convention (say "make this rule global" to promote a rule up).

## Security & secrets
- **Secrets never in the repo.** No key/token/password in a committed file, `.env`, or doc. Global master copy:
  `~/.claude/secrets/credentials.env` (gitignored). Copy only what a run needs into a gitignored `.env.local`.
  Never print a secret value; never commit one.
- **Never weaken auth/RLS/access control without explicit sign-off.**
- **No outward third-party actions as tests** (real emails, DMs, publishes, paid scrapes). Use dry runs / smoke
  tests. Ask before anything outward-facing or irreversible.
- **Don't provision paid infra** (VPS, Stripe, queues, voice, etc.) without a go-ahead.

## Ship / verify discipline
- **The remote/preview build is the authoritative build+typecheck gate**, not local (local installs are fragile).
  Branch → push → wait for the preview to go green → then promote. Verify behavior, not just that it compiled.
- **Adversarially review** non-trivial or security-sensitive changes (a skeptical subagent) and fix confirmed
  findings **before** shipping.
- **Production DB migrations + merges to the main/prod branch require explicit approval** naming the target.

## Working style (from `~/.claude/CLAUDE.md`)
- **Progressive disclosure:** long context → its own file + a one-line pointer; keep `CLAUDE.md` lean.
- **Skills over MCP; webhooks/REST over MCP** for acting on external systems.
- **Update the context docs each phase** (this is itself a rule) — especially `memory.md`.

## This project
- **`ENCRYPTION_KEY` scheme must stay in sync.** `frontend/src/lib/crypto.ts` and `backend/src/lib/crypto.js`
  both encrypt/decrypt the same secrets (SMTP passwords, LinkedIn session cookie) — never change one without
  the other.
- **No test suite exists anywhere** (frontend has no test script; backend's `npm test` is a placeholder) — there
  is no automated safety net, so be more conservative about unverified changes than usual.
- **Merging `backend/**` changes to `master`/`main` deploys to production immediately** (PM2 restart via SSH,
  no test/lint gate) — treat that merge itself as the deploy, not just a commit.
- **Admin gating is server-side only, never UI-only.** `NEXT_PUBLIC_ADMIN_EMAILS` + `is_blocked`/`allowed_products`
  must be enforced in the API route (`verifyAdmin()`), not by hiding the `AdminPortal` component. See
  [role.md](role.md).
