# Architecture

Three independent deployables, no shared code or root workspace — see [structure.md](structure.md) for what
lives where.

```
frontend/  Next.js 16 (TS) — UI + API routes, writes desired state to Supabase
backend/   Node/CommonJS — worker/scheduler, polls Supabase, does the actual sending/scraping
extension/ Chrome MV3 — grabs LinkedIn session cookie, hands it to frontend
```

## Data flow
1. **Frontend** is the control plane: user configures SMTP, recipients, role templates, and Automail settings;
   these are written to Supabase. Manual "Send" also happens directly from the frontend via `/api/send`
   (Nodemailer), not through the backend.
2. **Backend** is the execution plane: BullMQ queues (Redis-backed) + a scheduler (`scheduler.js`) drive three
   worker/queue pairs — `automail` (scheduled + AI-personalized sending), `batchSend`, `scraper` (LinkedIn
   recipient auto-fetch). Workers poll/consume from Supabase and Redis, do the work, and write execution logs
   back to Supabase. No HTTP server — it's a long-running process managed by PM2.
3. **Extension** has one job: extract the LinkedIn `JSESSIONID` cookie so the scraper worker can authenticate
   LinkedIn search requests on the user's behalf.
4. **AI personalization** (`backend/src/services/ai.service.js`) calls out to Groq / OpenAI / Gemini (base URLs
   configured via env — see [tools.md](tools.md)).

## Auth & entitlements
Supabase Auth (email/password). Admin status is an env-var email allowlist (`NEXT_PUBLIC_ADMIN_EMAILS`), not a
DB role column — it gates `/api/admin/*` routes server-side via `verifyAdmin()`. Per-user `is_blocked` and
`allowed_products` live in the `automailsend_app_state` table, set by admin, read/enforced server-side. Full
model in [role.md](role.md).

On `localhost` only, the frontend auto-signs-in with a dedicated dev account instead of showing the login
form (`isLocalDevHost()` in `app/[[...tab]]/page.tsx`, gated on both `NODE_ENV` and the actual hostname) —
real Supabase Auth + RLS still runs underneath, this just automates entering credentials for local dev.

## Sending model (as of 2026-08-17 — Phase 1 of the auto-apply roadmap)
Recipients are tagged by a user-owned **role** (`automailsend_role_defs` — free-text targets like job titles,
not the old hardcoded 4-value set; `role` columns elsewhere are plain `text`, unaffected by this). Sending
pulls from a **pool of SMTP accounts** (`automailsend_smtp_accounts`, each with its own daily cap, default
50) instead of one mailbox — `backend/src/lib/smtpPool.js` is shared by both `automail.worker.js` and
`batchSend.worker.js`, picking whichever active+verified account has the most remaining quota per send.
`automailsend_sent_log.smtp_account_id` records which account actually sent each email.

## Job targeting (as of 2026-08-17, extended same day — Jobs & Roles unification)
Each role (`automailsend_role_defs`) now owns its own LinkedIn search keywords/aliases (`keywords text[]`)
plus job-search "rules" — set together on the **Jobs & Roles** page (`JobsRolesTab.tsx`), not split across a
separate scraper config. Rules are deliberately **fixed-option over free text** wherever the choices are
enumerable (operator directive — consistent fields cost less/read more predictably once they feed
matching/prompts later): `work_mode` (remote/onsite/hybrid/any), `employment_type` (full-time/part-time/
contract/internship/any), `company_size`, `visa_sponsorship` are all dropdowns; `salary_currency`/
`salary_period`/`salary_min`/`salary_max` replace one free-text salary field. `keywords` and
`preferred_locations` are chip-lists (same add/remove UX, `ChipListField` in `JobsRolesTab.tsx`) — the two
fields where the value set is genuinely open-ended. `other_notes` is the one remaining free-text catch-all.
`backend/src/workers/scraper.worker.js`'s `processJob()` resolves the flat `{keyword, role}` mapping list
from `automailsend_role_defs.keywords` directly (a role with zero keywords is simply never searched);
`AutoFetchModal` now holds only scraper mechanics (interval, pagination, LinkedIn cookies, post-age filter).
None of the rules fields are used for matching/filtering yet — captured for the still-upcoming JAMS phase.

**No preloaded roles (fixed 2026-08-18)**: `storage.ts`'s `ensureDefaultRoleDefs` used to silently seed four
presets (DevOps/Fullstack/AI Automation/Custom) for a brand-new user. The operator wants every role built
from scratch — the free-text `RoleDef` model above already supported that fully; the auto-seed was the only
thing in the way. `ensureDefaultRoleDefs` is now a thin passthrough to `loadRoleDefs` (seeds nothing); new
users land on an empty role list and use `JobsRolesTab.tsx`'s "+ Add title" flow (its existing "No roles yet
— add one to get started" empty state is now a real, reachable first-run path instead of dead code).

## Template variables (as of 2026-08-17, extended same day; extended again 2026-08-31)
Fixed 10-token set, three kinds — see `RoleTemplates.tsx`'s in-app hint for the user-facing version:
- **Job-side** (scraped, best-effort): `{{title}}` (the search keyword that found the contact — recipients
  don't otherwise carry a real job title), `{{name}}` (the LinkedIn post's author when the scraper's
  attribution resolved one), `{{email}}`. Real or absent, never guessed.
- **Candidate-side** (from the Profile & Roles page, fully user-controlled): `{{candidate_name}}`,
  `{{candidate_email}}`, `{{candidate_phone}}`, `{{candidate_portfolio}}`, `{{candidate_resume_link}}`.
  Backed by `automailsend_candidate_profiles` (moved off `automailsend_app_state`'s old `candidate_name`/
  `_email`/`_phone`/`_portfolio_url`/`_resume_url` columns 2026-08-19 — see "Profile as knowledge base"
  below; those old columns are left in place, unused, same precedent as `candidate_info`'s neighbors).
  `candidate_info` (the free-text AI-personalization blurb) is unrelated and untouched, still on
  `automailsend_app_state`.
- **Follow-up-only** (2026-08-31, see "Dual credit system + automated follow-ups" below): `{{last_sent_date}}`
  (from `recipient.last_sent_at`, blank on a first-ever send), `{{follow_up_number}}` (from
  `recipient.follow_up_count + 1`). Resolve safely in any template, not just follow-up ones — a first-touch
  template using them just renders blank/"1", same tolerance as every other token. Deliberately excluded
  from Quick Send's "Insert variable" picker (a Quick Send recipient has no follow-up history by definition)
  but still resolved by `applyPlaceholders` if pasted in manually.

No `{{company}}` token — nothing in the scrape reliably identifies a company name (same reasoning as the
post-attribution fix below); the AI may still mention one in prose if the job post text states it.

All substitution goes through `applyPlaceholders(text, recipient, profile)` and the guardrail
`hasUnresolvedPlaceholders(text)` — both the single source of truth, exported from
`backend/src/services/ai.service.js`, imported by both send workers; never re-copy these (three duplicate
copies of `applyPlaceholders` caused real drift once already). AI-personalized sends get candidate contact
info as a labeled `CANDIDATE CONTACT INFO` block in the prompt (not left to inference), and still run
`applyPlaceholders()` on the AI's output as a safety net. **Hard guardrail**: right before actually sending,
both workers check the final subject+body with `hasUnresolvedPlaceholders()` — if a literal `{{...}}`
survives, the send is blocked (marked failed, logged, no SMTP quota spent) rather than delivered.

## Job matching — JAMS (as of 2026-08-18)
Scraped job posts carry **no structured job data** — `automailsend_job_posts` only has `source_url`/
`context_text` (a bounded, best-effort text snippet, not a parsed listing)/`author_name`. So matching a
post against a role's rules (`work_mode`, salary, `employment_type`, `company_size`, `visa_sponsorship`,
`preferred_locations` — see "Job targeting" above) is an AI read of that free-text snippet, not a SQL
comparison. `backend/src/services/ai.service.js`'s `scoreJobMatch(contextText, sourceUrl, role)` builds a
criteria block from only the role's *actually-set* fields (an all-`'any'` role returns `null` — nothing to
check, so no AI call is made) and returns `{ score: 0-100, reasoning: "<=160 chars" }` via the same
Gemini dispatch (JSON-mode + 429 retry) `generateAiPersonalizedEmail` already uses (`callAiJson`, extracted
as the shared helper — platform-managed, credit-metered, see "Platform-managed AI" below).

Scoring runs **automatically at scrape time** (operator's choice, not on-demand): `scraper.worker.js`'s
`saveContacts()` scores a newly-seen job post once, right after `getJobPost()` upserts it — gated on
`match_analyzed_at` being null (so it's never repeated for a post already scored) and on the matched role
actually having criteria set. Results (`match_score`/`match_reasoning`/`match_analyzed_at`) are written to
`automailsend_job_posts` and denormalized onto every `automailsend_recipients` row for that post (same
reasoning as `author_name`/`context_text`/`source_url`). A transient AI failure leaves `match_analyzed_at`
null so a future scrape run retries it, rather than getting stuck "analyzed" with no score.

**Where matching lives in the UI (corrected 2026-08-18, superseded 2026-08-26 — see follow-up below)**: the
browsable, scored job-post board used to live on `JobsRolesTab.tsx` itself; that board is gone now — see
below. The grouping logic (`groupRecipientsByJobPost`) and score→color/label mapping (`matchScoreTone`)
still live once in `frontend/src/lib/jobPosts.ts`, and the card itself in
`frontend/src/components/JobPostCard.tsx`, consumed only by `JamsTab.tsx`/`ApplicantsModal.tsx` now.

### Follow-up (2026-08-26) — real AI-driven include/exclude filtering, not just structured-criteria scoring
The actual scrape mechanism, confirmed end to end: LinkedIn is searched once per **Include Keyword**
(`RoleDef.keywords`, unchanged — this is what hits LinkedIn's own search bar), every returned post is
stored, then `scoreJobMatch` reads the raw text against the role's rules. What changed this pass is what
that AI read considers:
- **Exclude Keywords** (`RoleDef.excludeKeywords` / `exclude_keywords`) — never used to build the search
  query (there's no "exclude" operator in play); purely an AI-filtering signal — a post genuinely about one
  of these scores low (0-15) even though it surfaced from an Include Keyword search.
- **AI matching instructions** (`RoleDef.aiInstructions` / `ai_instructions`) — free text the candidate
  writes directly, e.g. "Only match low-code/no-code roles." Highest priority of the three — the updated
  `JOB_MATCH_SYSTEM_PROMPT` explicitly tells the model to follow this over both Exclude Keywords and the
  structured criteria when they conflict.
- `buildRoleCriteriaBlock`/`scoreJobMatch` in `ai.service.js` gained `buildExcludeKeywordsBlock`/
  `buildAiInstructionsBlock`; `scraper.worker.js`'s `roleHasCriteria` now also triggers scoring when either
  of these two is set alone, even if every structured field is still `'any'`.

**The board itself moved (2026-08-26, operator ask — "remove the match job posts from the roles as it is
moved to JAMS")**: the "Matched job posts" card + strictness slider that used to sit at the bottom of
`JobsRolesTab.tsx` is deleted outright — it duplicated what `JamsTab.tsx` (JAMS's "Emails" sub-tab) already
shows per-contact via `matchScoreTone(r.match_score)`. `JobsRolesTab.tsx` is now purely the criteria editor;
there's no second scored-post view anywhere else.

**Role criteria fields became pill multi-selects (2026-08-25/26, operator ask — "if I want to select
multiple company sizes... skip enterprise," then "I could be open to multiple types of employment... work
modes")**: `company_size`/`work_mode`/`employment_type` (each a single-select `'any'`-or-one-value column)
are retired — unread by the UI or `buildRoleCriteriaBlock` going forward, kept on the schema (same
"superseded, never dropped" precedent as every other retired field in this project). `company_sizes`/
`work_modes`/`employment_types` (`text[]`, empty = no restriction) replace them, edited via a new shared
`MultiSelectChipField` component — same pill-with-× visual/UX as the pre-existing "Preferred countries"
`ChipListField`, just picking from a fixed option list via a dropdown+Add instead of typing free text.
`buildRoleCriteriaBlock` joins each array with "or" (`Work mode: remote or hybrid`) — any one of the listed
values counts as a match, not all of them. Existing single selections were backfilled into the new arrays
on migration, not lost. `other_notes` was removed from the Roles UI the same day — confirmed it never
reached the AI matcher or resume composer, so it wasn't serving any purpose; field/column kept, unread.

## JAMS consolidation — the unified lifecycle hub (2026-08-18)
Operator's target flow is: connect SMTP → scraper (plain LinkedIn API calls + parsing, no AI) finds HR
contacts against a role's keywords → AI personalizes and sends the outreach email → the whole thing gets
tracked in one place. That lifecycle used to be spread across five top-level tabs that each showed a slice
of the same `automailsend_recipients` data — **Scraper & Contacts** (manual add/import), **Sending &
Automail** (batch send + history), **Quick Send (AI)** (single-contact instant send), **Logs** (automation
run log), and **JAMS** (a flat outreach tracker). The first four were folded into JAMS so a contact's whole
story — found → matched → contacted → sent/logged — lives in one screen instead of four. Nothing about the
*backend* changed: the scraper worker, AI email personalization, AI match scoring, and the batch-send queue
(`automailsend_app_state.batch_send_pending`/`config.batchMode`/`config.batchTargetIds`, consumed by
`batchSend.worker.js`) are exactly as before — this was purely a frontend IA consolidation.

`frontend/src/components/JamsTab.tsx` is now the *after* side of the lifecycle — every contact found
(scraped or manual), filterable/searchable, showing each scraped contact's match score as read-only
context (`matchScoreTone`/`StatusPill` shared with `JobsRolesTab`/`JobPostCard`, see above) — plus what it
absorbed:
- **Quick Send** (updated 2026-08-18 — see below) — a modal (`QuickSendModal.tsx`), not an inline row:
  HR name, HR email/phone, a **separate** job title/position field, a role picker that offers that role's
  saved template, a subject/body draft, an "Insert variable" picker, and an "Enhance with AI" action,
  sending **synchronously** via `/api/send` rather than through the batch queue. HR name and job title are
  deliberately two different fields/DB columns (`author_name` vs. `title`) — an early version conflated
  them into one "HR name" input feeding both `{{name}}` and `{{title}}`, which visibly broke any template
  using both (e.g. "Hi {{name}}," and "...the {{title}} position" both resolved to the HR contact's name).
- **Sending, inline on the table** — reuses `SendPanel`'s `sendList()` logic verbatim (same batch-queue
  mechanism, same verified-SMTP-account and daily-limit guards) as per-row Send/Send AI/Resend buttons plus
  a bulk selection toolbar (Send Selected — Template/AI, Delete Selected); dropped `SendPanel`'s three-
  column Pending/Skipped/History layout since the flat table's status filter already covers that. Rows
  just queued this way show a "Queued — sending soon…" state instead of a static Pending (see below).
- **Per-contact history, not a separate log tab** — each row expands to show that contact's own send
  history (matched by `email`+`role` against `sentLog`, same `sentKey()` helper `SendPanel` used) with a
  subject/body preview and failure reasoning — the "whole lifecycle from data" made concrete: a row *is*
  one contact's story end to end, not something you cross-reference against a separate table.
- **Automation Activity** — `ExecutionLogsPanel.tsx` (all job types together, unmodified) mounted inside
  JamsTab as a collapsed-by-default section (`localStorage`-persisted open/closed) instead of owning its
  own sidebar tab. **Tried and reverted (2026-08-18)**: a second, `jobType`-filtered "Email Automation
  Activity" popup — broke immediately, because `ExecutionLogsPanel` opens a Supabase Realtime channel
  under one hardcoded name (`"execution-logs-updates"`); two instances mounted at once collide on that
  name and the second one throws (`cannot add postgres_changes callbacks... after subscribe()`), which
  crashed the JamsTab render tree. The operator also didn't want the split anyway ("we have our logs")
  — removed entirely rather than fixed, so there is only ever one `ExecutionLogsPanel` instance mounted
  at a time again.

`RecipientManager.tsx`, `SendPanel.tsx`, and `QuickSendTab.tsx` are deleted. Sidebar/`TAB_NAMES` in
`page.tsx` dropped from 10 entries to 6 (**JAMS**, **Jobs & Roles**, **Profile**, **Templates & AI**,
**Settings**, **Admin**); JAMS is now the landing tab. Settings (SMTP accounts, `AutoFetchModal` scrape
mechanics, `AutomailModal` AI/automail config, password) stays separate — it's configuration, not lifecycle
data, same reasoning as Jobs & Roles owning criteria vs. JAMS owning contacts.

### Follow-up (2026-08-25/26) — Dashboard tab came and went; JAMS is the landing page again with sub-tabs; Settings rebuilt as a flat card grid
Between 2026-08-18 and 2026-08-25 a separate `DashboardTab.tsx` existed as its own landing tab (stats,
connections, automation toggle) alongside JAMS. The operator's later, more detailed ask ("the dashboard is
looking more like a setting... keep JAMS as our main dashboard, with tabs — overall/stats, mails sent [the
CRM], monitoring — and merge settings into a similar layout") collapsed that back down:
- **`DashboardTab.tsx` is deleted.** `JamsHub.tsx` (new) is the actual landing component now — owns the
  page-level "JAMS" header and an Overview/Emails/Monitoring sub-tab strip (local `useState`, no routing).
  `JamsOverviewTab.tsx` (new) is "Overview" — stat tiles (sent today, total contacts/sent, replies, AI
  credits), recent activity, by-role breakdown, the "+ Quick Send" button. `JamsTab.tsx` (unchanged
  internally) became "Emails" — trimmed its own outer `<section className="panel">` wrapper since `JamsHub`
  now owns that shell; its daily-limit chip moved inline into the body instead. "Monitoring" is a bare
  `ExecutionLogsPanel`.
- **`SettingsTab.tsx` was first rewritten as a tabbed page (Automation/Connections/Account), then corrected
  same pass to a flat grid of bordered cards** — matching `JamsOverviewTab`'s own stat-tile/card visual
  language rather than adding a second internal nav pattern (operator: "a similar layout to the dashboard").
  Cards: SMTP Accounts (opens the same `SmtpConfigPanel` popup as always), LinkedIn (opens the same
  `AutoFetchModal`), an Email section embedding `EmailConfigTab` (who writes each role's email — manual/let
  AI choose/let AI write), a Resume card (a plain pointer to `profile.globalResumeId`'s file, deliberately
  no AI-editing controls — see "explicitly out of scope" note below), and an Account card (password change).
  The template libraries (Email Templates, Resumes) stay fully separate, exactly as before — Settings only
  ever holds config/connections, never template content.
- **Automation's control moved twice in two days.** First landed on `JamsOverviewTab` as a full card
  (checkbox + progress bar + editable daily-limit input) when `DashboardTab` was folded in. Next day, per
  operator ask ("move the automation section from JAMS to the settings... just have a quick toggle button,
  like play or pause... forget about the whole section"), that whole card was deleted and replaced by a
  single compact Automation card on `SettingsTab` — one Play/Pause button (toggles `automail.enabled`) +
  read-only "Sent today: X / Y" text. The editable daily-limit input was dropped along with the rest of the
  section, not preserved elsewhere.
- **Explicitly deferred, not built**: a "Resume for AI" feature the operator described in detail — an
  instance of a profile-based resume with per-field AI-editability toggles (locked: name/company/dates;
  toggleable: summary/descriptions), auto-tailored per job description with an AI-chosen name. Operator:
  "do not build this right now... add it to the phase after we build the admin portal." Roadmap as stated:
  1) pricing/credit control/API hardening (mostly done — see the "Manual per-user plan overrides" and "API
  hardening" sections), 2) an unresolved second phase (possibly the admin portal, never explicitly
  confirmed), 3) this Resume-for-AI feature.

## Manual per-user plan overrides (2026-08-25) — a stepping stone toward real plan tiers
Explicitly scoped small by the operator ("this is for now — later we will integrate it and turn it into a
complete SaaS product"), not a self-serve billing/packages system: two nullable admin-only override columns
on `automailsend_app_state`, both `null` by default (zero behavior change until an admin sets one via
`AdminPortal.tsx`'s new `OverrideCell`):
- **`max_keywords`** — caps a candidate's total search keywords across every role combined.
  `JobsRolesTab.tsx` enforces it client-side, stacked on top of the pre-existing per-role `MAX_CHIPS = 15`
  cap (a separate, smaller ceiling that was already there).
- **`min_fetch_interval_override`** — this candidate's own floor for the LinkedIn Auto-Fetch "Run interval
  (minutes)" setting, overriding the app-wide 180-minute default (`AutoFetchModal.tsx`'s
  `DEFAULT_MIN_INTERVAL_MIN`). Distinct from `automailsend_global_settings.min_fetch_interval`, a *global*
  floor applied to everyone with no override set.
- The API route pattern (`/api/admin/users/route.ts`) checks `!== undefined`, not `!== null`, when deciding
  whether to touch these columns in a PATCH — an explicit `null` in the request body correctly *clears* an
  override, distinct from the field simply not being sent.

## Dual credit system + automated follow-up emails (2026-08-31, MVP push)
Operator push toward a real launch (3-5 paying users, 25-50 emails/day each): "There will be a price on
everything, everything, even sending mail with the template... you are using my server, you are using the
application that I have built." Two credit currencies now, both on `automailsend_app_state`:
- **`app_credits`** (new, default 2000 — deliberately generous since it gates every send from day one,
  unlike `ai_credits`, which only ever gated opt-in AI features) — spent by `spendAppCredit`
  (`backend/src/lib/appCredits.js` / `frontend/src/lib/appCredits.ts`) on **every** send: manual, template,
  resume-attached, and follow-up. Checked as a pre-flight gate before any template/AI work in all 3 send
  paths (`automail.worker.js`, `batchSend.worker.js`, `frontend/src/app/api/send/route.ts`), spent only
  after `sendMail()` actually succeeds.
- **`ai_credits`** (existing) — spent *in addition* to `app_credits` whenever AI actually wrote the content
  (`ai-write` mode, or an AI-written follow-up slot). Unchanged in every other respect.
- Insufficient-credit handling (either currency) is uniform: log once, skip that recipient silently after,
  never change `recipient.status` or insert a `sent_log` row — a transient, admin-recoverable shortage must
  never permanently drop a recipient (`batchSend.worker.js` in particular excludes anyone with an existing
  `sent_log` row in `status in (sent, skipped)` from all future runs, so a `skipped` row there would be
  permanent, not transient).
- `frontend/src/app/api/send/route.ts` (Quick Send) had **no authentication at all** before this — added
  `getAuthedUserId`, same pattern as `resume-import/route.ts`, since a credit spend now needs a real caller
  identity. `QuickSendModal.tsx` sends a Bearer session token accordingly.

**Follow-ups**: up to 3 per recipient, automated by a 5th scheduler loop (`backend/src/workers/
followUp.worker.js`, wired into `scheduler.js` exactly like the other 4 `setInterval` loops — this backend
is not BullMQ, see the note near the top of this file). Per-role settings (`automailsend_role_defs`):
`follow_up_interval_days` (nullable — null means off for this role, no separate boolean flag column) and
three independently-nullable `follow_up_template_{1,2,3}_id` FKs (null = AI writes that slot, the default;
set = that template sent verbatim, no AI). `automailsend_recipients.next_follow_up_at` is precomputed at
send time (via `computeNextFollowUpAt(roleDef)`, a small shared helper in `emailResolve.js`/`.ts`) rather
than derived per-tick, so the worker's eligibility query is a plain indexed range scan
(`idx_automailsend_recipients_followup_due`). A reply (`has_replied`, already flipped live by
`replyPoll.worker.js`) stops further follow-ups automatically — the eligibility query checks it directly, no
extra wiring needed. An SMTP failure retries the same slot's content on a 1-day backoff without advancing
`follow_up_count`; a successful send always advances it, and hitting 3 sets `next_follow_up_at` back to
null — that alone enforces the cap, no separate "exhausted" flag. AI-written follow-ups go through a new
`generateFollowUpEmail` in `ai.service.js` (parallel to `generateAiPersonalizedEmail`), given the recipient's
most recent `sent_log` row as "what was already said" so it writes a genuine continuation, not a repeat.

## Credentials at rest: LinkedIn session encryption (2026-08-31, foundation hardening)
Operator raised whether the app's own security was actually sound — auditing found `docs/rules.md`'s claim
that the existing AES-256-GCM scheme (`frontend/src/lib/crypto.ts` / `backend/src/lib/crypto.js`,
`enc:iv:authTag:data` format) covers "SMTP passwords, LinkedIn session cookie" was only half true: SMTP
passwords genuinely are encrypted (`verify/route.ts` encrypts on save, `smtpPool.js`/`imapPool.js` decrypt
only at connection-build time), the LinkedIn session was not. `automailsend_app_state.cookie_li_at` /
`.cookie_jsessionid` / `.auto_fetch_raw_headers` (the last one is what actually drives live scraping — see
`scraper.worker.js`) is a complete, working LinkedIn session with no password/MFA needed to use it. Fixed by
mirroring the SMTP pattern exactly: `frontend/src/app/api/verify-linkedin/route.ts` (gained an auth gate it
never had) decrypts-if-needed before pinging LinkedIn, then returns `encrypted{LiAt,Jsessionid,RawHeaders}`
for the caller to persist. Both write paths in `AutoFetchModal.tsx` now route through it —
`handleConnect` previously called `onSave` directly with raw extension plaintext (the actual gap);
`handleSave` now round-trips whenever there's a live connection to persist, not just when Enabled is
checked, closing an edge case where toggling Enabled off before Save could silently overwrite an
already-encrypted row with stale local-state plaintext. `scraper.worker.js` decrypts
`auto_fetch_raw_headers` immediately before its existing `JSON.parse` (legacy-passthrough-safe via
`decryptPassword`'s existing "not `enc:`-prefixed? pass through unchanged" behavior). Zero schema change.

## Lemon Squeezy subscriptions (2026-08-31, foundation hardening)
Real recurring billing, replacing "credits are 100% admin-granted" as the only lever. Chosen over
Stripe/Paddle specifically for confirmed Pakistan-seller payout support. New nullable columns on
`automailsend_app_state`: `ls_customer_id`, `ls_subscription_id`, `subscription_status` (mirrors Lemon
Squeezy's own enum verbatim), `plan_tier` (`'free'|'pro'|'premium'`, defaults `'free'` — unlike the manual
override columns, this always has a real value, not "unset"), `current_period_ends_at`, `ls_synced_at`
(the subscription object's own `updated_at`, used for webhook idempotency, not our write time).

**Layers on top of, does not replace,** the existing 4 manual admin-override levers (`ai_credits`,
`max_keywords`, `min_fetch_interval_override`, `daily_mail_limit` — see "Manual per-user plan overrides"
above) — `TIER_LEVERS` in `frontend/src/lib/lemonSqueezy.ts` maps each tier to exactly those 4 values,
lifted verbatim from `docs/pricing-tiers.md`'s already-designed table. `frontend/src/app/api/billing/
webhook/route.ts` only overwrites `plan_tier` + the 4 levers on a **genuine tier-change event**
(`subscription_created`, a `subscription_updated` whose resolved tier differs from the stored one, or
`subscription_expired`) — every other delivery (a routine `subscription_payment_success`, a same-tier
`subscription_updated`, `subscription_cancelled`) only touches `subscription_status`/
`current_period_ends_at`/`ls_synced_at`, so an admin's hand-set override on the 4 levers survives anything
short of an actual plan change. `subscription_cancelled` deliberately does NOT touch `plan_tier` — mirrors
Lemon Squeezy's own semantics (a cancelled sub rides out its already-paid period); only the later
`subscription_expired` event triggers the real downgrade to Free. Idempotency: the webhook compares the
incoming subscription object's own `updated_at` against the stored `ls_synced_at` and skips stale/duplicate
redeliveries — Lemon Squeezy can and does redeliver.

Three routes: `/api/billing/checkout` (authed, creates a hosted Checkout tagged with `checkout_data.custom.
user_id` so the webhook can map back to a Supabase user without relying on email matching), `/api/billing/
webhook` (no session auth — authenticates via `X-Signature` HMAC instead, verified with
`crypto.timingSafeEqual`; only processes `data.type === "subscriptions"` events, acks and ignores
payment-lifecycle events which carry a different resource shape and never change `plan_tier` on their own
anyway), `/api/billing/portal` (authed, returns Lemon Squeezy's own pre-signed Customer Portal URL — the one
surface where a user cancels/pauses/changes plan/updates payment method; not cached, the signed URL is only
valid 24h). `BillingCard.tsx` (self-contained, mirrors `TwoFactorSettings.tsx`'s pattern) renders inside a
new "Billing" card in `SettingsTab.tsx`'s flat card grid.

**Env vars needed** (operator-provisioned, not yet live as of this writing): `LEMONSQUEEZY_API_KEY`,
`LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `LEMONSQUEEZY_VARIANT_ID_PRO`,
`LEMONSQUEEZY_VARIANT_ID_PREMIUM` — same two-places pattern (`frontend/.env.local` + Vercel project env) as
`GEMINI_API_KEY`. Code builds and type-checks against these names regardless; live checkout/webhook
verification is blocked until the operator creates the Lemon Squeezy store + Pro/Premium products/variants.

## Quick Send's synchronous path + queued-send feedback (2026-08-18)
Bulk/per-row sends in the JAMS table go through the backend's polling batch queue
(`automailsend_app_state.batch_send_pending`/`config.batchMode`/`config.batchTargetIds`, consumed by
`batchSend.worker.js`) — appropriate for batches, but it made a single manual send look stuck: the worker
polls every ~10s (`BATCH_INTERVAL_SEC`) and then waits `send_delay_sec` (anti-ban jitter) before actually
sending, so a row could sit reading "Pending" for tens of seconds with nothing visibly happening. Two
separate fixes:
- **Quick Send bypasses the queue entirely.** `frontend/src/app/api/send/route.ts` (Nodemailer +
  `decryptPassword`) already existed but had zero callers anywhere in the app. `QuickSendModal.tsx` now
  calls it directly for its one-off send — no polling latency, immediate success/failure. It picks the
  first verified+active `SmtpAccount` (no need for the backend pool's quota-fair rotation for a single
  manual send), builds the final subject/body with a new frontend port of `applyPlaceholders`/
  `hasUnresolvedPlaceholders` (`frontend/src/lib/placeholders.ts` — mirrors `ai.service.js`'s copy, same
  "keep in sync" reasoning as `crypto.ts`/`crypto.js`), and writes the result with the already-existing
  `addSentLog()` (`storage.ts`) — which already handles both the `sent_log` insert and the recipient
  status update, no new plumbing needed. "Enhance with AI" goes through a new same-reasoning pair —
  `frontend/src/lib/aiClient.ts` (ports `callAiJson`'s dispatch) called from
  `frontend/src/app/api/ai-enhance/route.ts` — with its own prompt (not
  `JOB_APPLICATION_SYSTEM_PROMPT`, which assumes a scraped job post; Quick Send has none) for polishing a
  manually-drafted (possibly blank) subject/body using the candidate's profile/`candidateInfo`. (2026-08-18:
  this route now uses the platform's own Gemini key and an auth-checked credit spend — see "Platform-managed
  AI" below — rather than a client-supplied API key.)
- **Table sends now say when they're queued.** `JamsTab.tsx` tracks a `queuedIds` set — populated when
  `sendList()` successfully hands a batch to the worker, cleared per-id once that recipient's `status`
  changes away from `"pending"` (arrives via the existing realtime subscription) or after a 90s safety-net
  timeout. A queued row shows "Queued — sending soon…" instead of its Send/Send AI/Resend buttons.

### Follow-up (2026-08-25) — explicit compose modes, not an implicit default
Previously Quick Send silently used whatever mode a role's `EmailConfigTab` setting implied. Operator ask:
compose choice should be explicit, every time, in the modal itself. `QuickSendModal.tsx` gained a
`ComposeMode` radio group ("write" / "ai" / "template" — same visual pattern as `EMAIL_SEND_MODES`); picking
"template" reveals a dropdown scoped to the open role's own template pool (`selectTemplate(id)` populates
subject/body); the subject field is now always editable regardless of mode (previously only in some modes).
`enhance()` (the "Generate"/"Regenerate" AI action) works from an empty draft, not just a polish pass.

## Template library redesign — multiple templates + a separate resume library (2026-08-18)
> **Superseded 2026-08-19** — the randomization mechanism described below (`pickFromPool`,
> `is_default`/`in_randomizer`, the separate role-scoped resume library) was removed entirely. See
> "Email Templates redesign" further down for what replaced it; kept here for history since the DB
> columns/table it describes are still physically present, just unused.

`automailsend_templates` used to be exactly one row per role (`unique(user_id, role)`). It's now a real
library: any number of rows per role, one flagged `is_default`, any subset flagged `in_randomizer`. A
brand-new `automailsend_resumes` table (same shape — `label`/`files`/`is_default`/`in_randomizer`, no
subject/content) is **deliberately separate** from email templates — confirmed via `AskUserQuestion` —
so resume-file choice can rotate independently of pitch text (or vice versa) rather than the two being
locked together. Attachments merge at send time: whichever template was used contributes its own `files`,
and whichever resume was used contributes its own, concatenated into one attachment list.

**Selection logic** — `pickFromPool(rows)`, mirrored in `backend/src/lib/templatePicker.js` and
`frontend/src/lib/templatePicker.ts` (same "keep in sync" reasoning as `crypto.ts`/`crypto.js`): if 2+ rows
are flagged `in_randomizer`, return a random one of those; otherwise return the row flagged `is_default`,
falling back to the first row if none is (defensive). Both `automail.worker.js` and `batchSend.worker.js`
now fetch the full array per role and call `pickFromPool()` **per recipient**, not once per batch — that's
what makes randomization actually vary the outgoing content send-to-send rather than picking once and
reusing it for the whole run.

**UI**: `RoleTemplates.tsx` ("Templates & AI" tab) became a list+detail library editor — per-role list of
templates (label, Default badge, Randomize checkbox, Duplicate/Delete/"Set as default"), explicit "Save
changes" per edit rather than a network call per keystroke (the old single-template version did save on
every keystroke; not worth keeping now that saves are real per-row updates via `storage.ts`'s
`saveTemplate`/`deleteTemplate`/`setDefaultTemplate`, mirroring the existing `saveRoleDef`/`deleteRoleDef`
pattern). New `ResumesTab.tsx` + sidebar tab **"Resumes"** is the same pattern, simpler (no subject/body).
`CandidateProfile.resumeUrl` (a plain link for the `{{candidate_resume_link}}` token, e.g. a Drive URL
mentioned in prose) is untouched — a link and an actually-attached file are different things.

**Quick Send** (`QuickSendModal.tsx`) resolves its own pick client-side since it sends synchronously (no
worker in the loop): a Template select (`Auto` / `Custom` / a specific named template) and a separate
Resume select (`None` / `Auto` / a specific one). Picking a specific template loads its content into an
editable draft — edits there are guaranteed to be what's sent, no re-roll. `Auto` shows the *default*
template as a read-only preview (editing is disabled — there's nothing meaningful to edit when the actual
content is resolved fresh at send time) and re-resolves via `pickFromPool()` at the moment of sending, not
from the frozen preview, so `Auto` genuinely randomizes rather than always sending whatever rendered first.

**Sent-log snapshot (2026-08-18)**: once randomization means the same recipient could plausibly have
received any of several template/resume variants, `automailsend_sent_log` needed a record of *which one*
— added `template_label`/`resume_label` text columns, filled in at every insert site in both workers
(sent/failed/skipped/blocked) and in `QuickSendModal.tsx`'s client-side `addSentLog` call
(`templateLabel: "Custom"` when the send used a hand-written draft with no library template at all). A
label snapshot, deliberately not a foreign key — the library row can be renamed, edited, or deleted after
the fact, and the log should keep reflecting what was actually sent, not what the row says today. Shown in
`JamsTab.tsx`'s per-recipient send history and its "Sent Email Preview" modal.

## Resume Builder (2026-08-18)
A resumai.com-style structured builder — genuinely separate from the `automailsend_resumes` file library
above (structured, editable *data* vs. a finished *file*), living inside the same **Resumes** tab as a
segmented **Files / Builder** sub-view (`page.tsx`'s `resumesSubTab` state) rather than its own sidebar
entry, to avoid re-growing the tab count right after the consolidation work.

New `automailsend_resume_profiles` table — one JSONB `data` column holding the whole structured shape
(`personalInfo`, `summary`, `experience[]`, `education[]`, `skills[]`, `projects[]`, `certifications[]`,
`languages[]` — `ResumeData` in `types.ts`) rather than normalizing each section into its own table, same
convention as `files`/`details` jsonb columns elsewhere in this schema. A user can keep several
`ResumeProfile`s; `personalInfo` is seeded from `CandidateProfile` only once, on creation — not a live
sync afterward.

`ResumeBuilder.tsx`: left = per-section form (Personal Info, Summary, Experience, Education, Skills,
Projects, Certifications, Languages — repeatable entries where relevant), right = a live preview rendered
by whichever template component (`lib/resumeTemplates/{Modern,Classic}Template.tsx` — pure `ResumeData →
JSX`, 1–2 clean/ATS-friendly layouts per the operator's own "function over design for now" direction) is
selected. The form→preview binding is plain React state, **no AI, no network call** — the "reaches itself"
behavior the operator asked for. Saves are debounced (~800ms), not a manual button — too many fields for a
save-per-click to be pleasant; same idea as `page.tsx`'s existing `app_state` debounce.

**Export — two different mechanisms for two different needs**, reconciled during planning:
- **Download PDF** is plain `window.print()` — a `.resume-print-area` class (`globals.css`, A4-sized) plus
  a `@media print` block that hides everything else on the page (`.no-print`) so the browser's native print
  dialog captures only the resume. Zero new dependencies, exactly what was asked for export.
- **Save to Resume Library** needs an actual uploadable file, which `window.print()` can't give JS access
  to — added `html2canvas` + `jspdf` (small, purely client-side, no headless browser) used *only* for this
  one action: captures the same preview DOM, builds a PDF blob, uploads it via the existing
  `uploadAttachment()`, and creates an entry in `automailsend_resumes` via last phase's `saveResume()` — the
  builder feeds the library that already exists, confirmed via `AskUserQuestion`.

**Multi-page pagination (fixed 2026-08-18)**: both export paths originally collapsed a long resume onto one
overflowing sheet instead of real page breaks. `window.print()`'s `@media print` block now clears the
on-screen preview's `transform: scale(0.82)` (`transform: none !important` — a transformed subtree doesn't
paginate across `@page` breaks in Chromium's print engine) and forces `.app-container`'s normally-`100vh`/
`overflow:hidden` shell to `height:auto;overflow:visible` (it stays in the DOM, only `visibility`-hidden, so
its fixed height could still clip anything taller than one screen). `handleSaveToLibrary`'s `html2canvas` →
`jsPDF` path was calling `addImage()` once with the entire tall canvas (`addImage` has no pagination of its
own); it now slices the canvas across `pdf.addPage()` calls, one page-height at a time. The resume templates
already had `breakInside: "avoid"` on each entry, so once native pagination works, entries don't get split
mid-block across a page.

**Import — the one AI-powered path** (everything else above is explicitly not AI): "Import from a resume"
uploads a PDF to `frontend/src/app/api/resume-import/route.ts`, which extracts text via `pdf-parse` (text-
based PDFs only, no OCR for scans) and calls a new `parseResumeText()` in `lib/aiClient.ts` (new prompt,
same `callAiJson` dispatch already there) to structure it into `ResumeData` — returned to the Builder for
the user to review before it's saved, never auto-persisted. Gated on `automail.aiEnabled` and the caller's
AI credit balance (2026-08-18 — see below), same as every other AI feature in this app.

## Platform-managed AI — no more BYOK (2026-08-18)
Every AI feature (background personalization, JAMS job-match scoring, Quick Send's "Enhance with AI",
Resume Builder's PDF import) used to require each user to bring their own provider + API key
(`automailsend_app_state.ai_provider`/`ai_api_key`, entered in `AutomailModal.tsx`). Replaced with a
platform-managed model, confirmed via `AskUserQuestion`: **hard switch** (BYOK removed, not kept as an
optional override), a **Gemini key dedicated to Cuneihire** (separate from the operator's other
already-in-use shared Gemini key), **admin-granted credits only** (no payment/purchase flow exists in this
codebase yet).

- **Schema**: `automailsend_app_state` gained `ai_personalization_enabled boolean` (replaces the old
  provider dropdown — one on/off toggle) and `ai_credits integer default 20` (admin-adjustable per user).
  `ai_provider`/`ai_api_key` are left in place, unused — this project's usual precedent for superseded
  columns, no data migration needed.
- **The Gemini key itself lives server-side only**, in two separate places since these are two separate
  deployments that both call it directly: `backend/.env` (workers, PM2) and `frontend/.env.local` /
  Vercel project env vars (the Next.js AI routes). `backend/src/services/ai.service.js`'s `callAiJson` and
  its `frontend/src/lib/aiClient.ts` twin collapsed from OpenAI/Groq/Gemini dispatch to Gemini-only —
  no UI path can reach the other providers any more.
- **Spending a credit**: one flat credit per successful AI call (email personalization, job-match score,
  Quick Send enhance, resume import) — no token-based metering, mirrors the existing daily-send-limit's
  simplicity. Spent *after* a successful Gemini response, never before, so a network/API failure doesn't
  cost the user a credit. Atomic without a dedicated Postgres function: read the current balance, then a
  conditional update guarded by that same value (`.eq("ai_credits", current)`) — a classic optimistic-lock
  pattern; zero rows updated means someone/something already spent it, treated as insufficient. Backend:
  `backend/src/lib/aiCredits.js`'s `spendAiCredit()`, used by all three workers. Frontend: the same logic
  inlined in `aiClient.ts` as `spendAiCredit()`.
- **The two Next.js AI routes** (`/api/ai-enhance`, `/api/resume-import`) were previously unauthenticated —
  they never touched the DB, so never checked who was calling. Now that they spend a credit per call, both
  require a real `Authorization: Bearer <session token>` (verified via `getAuthedUserId()` in `aiClient.ts`,
  same pattern as `/api/admin/users/route.ts`'s `verifyAdmin` minus the admin-email check) — the spending
  user is the actual authenticated caller, never a client-supplied field. `checkAiGate()` runs before
  attempting the Gemini call (enabled + credits > 0), returning a distinct "out of credits" error the UI
  surfaces as its own toast.
- **Backend workers** gate on `ai_personalization_enabled && ai_credits > 0` instead of the old
  provider/key presence check; on exhausted credits they fall back exactly like the old "AI not
  configured" path (plain template, no match score) and log it once per run, not per recipient.
- **`AutomailModal.tsx`** lost the Provider/Model/API-Key fields entirely — the AI-specific section moved
  out to its own tab (below), leaving this modal solely about background-sending mechanics (enable +
  daily limit). *(2026-08-26: `AutomailModal.tsx` itself is now deleted — see "JAMS consolidation"'s
  follow-up below for where the enable/daily-limit control lives today.)* **Admin Portal** gained a per-user
  numeric "AI Credits" cell (`CreditsCell` in `AdminPortal.tsx`) wired to `/api/admin/users/route.ts`'s
  existing per-user PATCH pattern (same shape as `is_blocked`/`allowed_products`).
- **Live-verified (2026-08-25)** — a real dedicated `GEMINI_API_KEY` was provisioned at Google AI Studio and
  set in `backend/.env`, `frontend/.env.local`, and Vercel's production env vars; a real AI-personalized
  email was confirmed sent end to end (PM2 logs + a direct Supabase read showing pending→sent). See the
  hardening follow-up immediately below for what that first real traffic surfaced.

### Follow-up (2026-08-25) — API hardening: rate limiting, input truncation, timeouts, retired-model fix
Getting a real key into production immediately surfaced two separate bugs, both root-caused with direct
evidence rather than guessed:
- **`gemini-1.5-flash` had been retired from the API** (confirmed via `GET /v1beta/models` against the live
  key returning no such model) — every call had been 404ing since before this session, meaning platform-
  managed AI had never actually worked end to end despite shipping 2026-08-18. Fixed by switching to the
  `gemini-flash-latest` alias (not a pinned version) in both `ai.service.js` and `aiClient.ts` — deliberately
  an alias so this exact class of bug (a hardcoded model name silently going stale, invisible until a real
  key is in place) can't recur the same way.
- **No rate limiting existed between Gemini calls** — three workers (`automail`, `batchSend`, `scraper`) can
  each loop over many recipients/posts in one run with zero spacing between real network calls. Fixed with
  one in-process throttle, `throttleGeminiCall()` inside `callAiJson` (both `ai.service.js` and its
  `aiClient.ts` twin) — a single `MIN_GEMINI_INTERVAL_MS` (default 4200ms, env-overridable) gate that every
  real Gemini attempt passes through, placed *after* the missing-key check (a zero-cost local fail that
  shouldn't be throttled) but *before* each retry attempt. One choke point protects all three backend
  workers since they all funnel through this one function; the existing 429 exponential backoff is the
  residual safety net for the frontend's separate serverless process, which can't share this module-level
  throttle.
- **Free-tier daily quota is a separate, harder ceiling than per-minute rate limiting** (found 2026-08-26,
  investigating "why do sends fail for some users") — a direct probe against the live key returned
  `RESOURCE_EXHAUSTED`: `GenerateRequestsPerDayPerProjectPerModel-FreeTier`, quota value **20 requests/day**
  for `gemini-3.7-flash` (what `gemini-flash-latest` currently resolves to), shared across every user on the
  one platform-managed key. Once exhausted, every AI call 429s for the rest of the day; `ai-write` mode
  recipients are silently skipped (not broken-sent) rather than failing loudly. **Operator decision
  (2026-08-26): stay on the free tier deliberately** until the product has real users — plan is to apply for
  Google startup credits once it ships, then move to a paid/pay-as-you-go tier. Not a bug to fix now.
- **Input truncation**: `truncateForPrompt(text, maxLen)` caps any candidate-controlled free text before it
  reaches a prompt (`candidateInfo` at 4000 chars, `aiInstructions` at 1000 chars) — defense against one huge
  paste inflating every future Gemini call's cost/latency, independent of whatever a UI's own `maxLength`
  enforces client-side. `ProfileTab.tsx`'s candidate-info textarea also gained a visible `maxLength` + a
  live character-count hint.
- **20s timeout** on every real Gemini call (both `axios.post`'s own `timeout` in the backend, and an
  `AbortController`-based timeout in `aiClient.ts` — native `fetch` has no built-in timeout) — an unbounded
  hang on one user's call would otherwise stall every other user's automation behind it in the same
  `for (const user of users)` loop.

## The AI tab — temperature + match strictness (2026-08-18)
Second half of the operator's original AI ask, completed once platform-managed AI/credits landed: AI gets
its own real sidebar tab (`AITab.tsx`, between Resumes and Settings) instead of living as a sub-section of
Automail — "Templates & AI"'s sidebar label was also corrected to plain "Templates" (that tab only ever
rendered `RoleTemplates`; the old label predated AI having anywhere else to live).

`AutomailConfig.aiEnabled` moved into a new, separate `AiConfig` type (`types.ts`) — `{ enabled,
temperature, matchStrictness }` — decoupled from "Automail" naming now that AI has its own home.
`PersistedState.ai: AiConfig` (user-editable, saved like any other setting) sits alongside the existing
`aiCredits: number` (admin-only, untouched, still never written from `saveAppState`).

- **Temperature** (0–1, default `0.4`) is threaded through every Gemini call as
  `generationConfig.temperature` — one shared value for email personalization, JAMS match scoring, Quick
  Send's enhance, and resume import. Both `ai.service.js`'s and `aiClient.ts`'s `callAiJson` gained a
  `temperature` parameter; `checkAiGate()` (the frontend AI routes' pre-flight check) now also returns it
  so `/api/ai-enhance`/`/api/resume-import` don't need a second query to get it.
- **Match strictness** (0–100, default `0` = off) is a *new*, separate, server-persisted gate — distinct
  from `JobsRolesTab.tsx`'s pre-existing strictness slider, which is untouched and stays a purely personal,
  client-side/`localStorage` *display* filter over already-computed scores. This new one has real teeth:
  **`automail.worker.js`'s fully-automated background loop** skips a recipient entirely — before any
  template rendering, AI call, or send attempt, no credit spent — when that recipient's `match_score` is
  set and below the threshold, logging it once per run. Deliberately scoped to *only* that fully-automated
  loop, not `batchSend.worker.js` (JAMS's manual/bulk sends) — those are sends the operator explicitly
  chose, not something a background "should I even bother" gate should silently block. A recipient with no
  score yet (`match_score === null`) is never gated — same "unknown isn't a fail" principle as
  `roleHasCriteria`.
- **Not yet live-verified** — same standing caveat as the platform-AI phase: no real Gemini key in place,
  so temperature's actual effect on output and the strictness gate's actual skip behavior haven't been
  click-tested. Build + worker syntax-check only.

## Reply monitoring — IMAP-polling inbound replies into JAMS (2026-08-19)
Tier 3 of the roadmap, deferred from the original JAMS build. Polls each user's real mailbox for inbound
mail and matches it back to a previously-sent outreach email, surfacing the match directly on the
contact's row in JamsTab. Fully greenfield — no prior reply/IMAP/thread scaffolding anywhere in the repo.

- **Per-account opt-in**, not automatic for every Gmail/Outlook account — a new "Enable reply monitoring"
  checkbox on each `SmtpConfigPanel` account (hidden for SendGrid/Resend, which are relay-only and have no
  real inbox). Reuses that account's existing `app_password` — Gmail/Outlook app passwords work for both
  SMTP and IMAP, so no new secret to collect or encrypt. New `backend/src/lib/imapPool.js` mirrors
  `smtpPool.js`'s shape (`buildImapConfig`), resolving `imap.gmail.com`/`outlook.office365.com` by default
  or an explicit `imap_host`/`imap_port` for a custom mailbox.
- **Follows the scheduler's existing convention** — a plain `setInterval` loop in `scheduler.js`
  (`REPLY_POLL_INTERVAL_SEC`, default 300s), same as automail/batch-send, not the BullMQ `Queue`/`Worker`
  path (confirmed dead code — real jobs run in-process, bypassing Redis, per an explicit Windows-hang-
  avoidance comment already in that file).
- **New `backend/src/workers/replyPoll.worker.js`**: for each IMAP-enabled, active SMTP account (across
  non-blocked users), connects via `imapflow`, searches `INBOX` `SINCE` a computed window
  (`imap_last_polled_at` minus a 2-day overlap buffer, or 14 days back on an account's first-ever poll —
  never an unbounded backlog scan), and parses each message via `mailparser`'s `simpleParser`.
- **Matching, in priority order** — every stored reply records which method found it (`match_method`),
  never presented as equally certain:
  1. **Header match** (authoritative): the inbound `In-Reply-To`/`References` header contains a
     `message_id` captured at send time. `automail.worker.js`/`batchSend.worker.js` now capture
     nodemailer's auto-generated `info.messageId` into `automailsend_sent_log.message_id` on every
     successful send.
  2. **Fallback** (`sender_subject`): the inbound `From` exactly matches a `sent_log.email`, and the
     subject (stripped of leading `Re:`/`Fwd:`) matches or contains the original sent subject — covers
     mobile/webmail clients that mangle threading headers.
  3. **No match → not stored.** `automailsend_replies` only ever holds attributable replies, never a dump
     of the whole inbox — bounds scope and avoids storing unrelated mail.
- On a match: inserts into `automailsend_replies` (deduped by `unique(user_id, message_id)`, both in app
  logic and at the DB level) and updates the matching `automailsend_recipients` row's
  `has_replied`/`replied_at`/`reply_count`. One broken mailbox never takes down the loop for others —
  per-account try/catch, logged via the existing `ExecutionLogger` (`jobType: "reply_poll"`), same
  "Automation Activity" panel every other worker already logs into.
- **Non-goals this phase** (explicit): no auto-pause of automail sends on reply — a recipient's `status`
  already moves off `pending` after first send, so this isn't a duplicate-send risk; the new "↩ Replied"
  badge in JamsTab is what stops a human from manually re-sending. No AI summarization of reply content,
  no reply/compose-from-app UI. Pure detect-and-surface.
- **Frontend**: `JamsTab.tsx` shows a "↩ Replied" badge next to the status pill and, inside the same
  expandable per-contact history section as sent-email history, a second stacked list of the contact's
  actual replies (from/subject/snippet/received-at), read-only. New `ReplyRecord` type + `replies` field
  on `PersistedState`, loaded in `storage.ts`'s `loadState()` and kept live via a new
  `automailsend_replies` INSERT realtime subscription in `page.tsx` (same pattern as the existing
  recipients/execution_logs/sent_log subscriptions). While wiring this in, also fixed a real pre-existing
  bug in that file's `automailsend_recipients` realtime UPDATE handler: it rebuilt the recipient row from
  a narrow field subset, silently dropping `match_score`/`context_text`/etc. (not just failing to add new
  ones) on every realtime update — now maps the full `Recipient` shape, matching `storage.ts`'s own
  mapping.
- **Dependency note**: added `imapflow` + `mailparser`. `mailparser`'s transitive `html-to-text` →
  `deepmerge-ts` chain had a known stack-exhaustion DoS advisory on attacker-controlled recursive input —
  relevant here since this worker parses genuinely untrusted inbound email. Fixed via an `overrides` entry
  in `backend/package.json` pinning `deepmerge-ts@^8.0.1` (the patched version) rather than downgrading
  `mailparser`; `npm audit --omit=dev` now reports 0 vulnerabilities.
- **Verified**: migration applied + confirmed live (all new columns, the new table, its unique constraint,
  and its RLS policy all checked directly against `information_schema`/`pg_constraint`/`pg_policies`), a
  direct-call test of the pure matching logic (`matchReply`/`stripSubjectPrefix`/`computeSinceDate` —
  header match, References-array match, sender+subject fallback, and both no-match cases), `node --check`
  + a `require()` load test on every touched/new backend file, clean `frontend` `npm run build`, dev
  server restart with a clean log. **Not yet live-verified**: no real IMAP-enabled mailbox has actually
  been polled, and no real reply has ever been sent to a Cuneihire outreach email — the IMAP connection
  itself, the search/fetch calls, and the end-to-end match-and-surface flow can only be syntax/schema-
  verified this session, not click-tested. Same standing caveat pattern as the Gemini-key gap.

## Recruiter portal + AI-assisted ATS (2026-08-19)
Tier 4 of the roadmap. Recruiters post jobs directly on Cuneihire; candidates apply in-app (no outside
portal, per the operator's own ask); an optional AI-ATS scores each application against the posting.
Confirmed via `AskUserQuestion`: build this over multi-platform scraping, and job postings go **live
immediately, no admin approval queue** (a bad-actor recruiter can still be shut down via the existing
Admin Portal `is_blocked` toggle). Fully greenfield before this — no schema, no auth branching.

- **Account type is chosen once at signup, not self-serve in-app** (revised 2026-08-19, same day, per
  operator follow-up feedback — the original build let any logged-in candidate flip on recruiter mode from
  inside the app; superseded). `signup/page.tsx` now has a Candidate/Recruiter selector; a recruiter
  signup must use a company email (`lib/companyEmail.ts`'s `isCompanyEmail()` — blocks the obvious
  well-known free/personal providers, a plain client-side check same trust level as the rest of this app,
  not exotic hardening) and can never be changed later — **one email is locked to one account type for
  good**. The chosen type is stored in the session's own `user_metadata` (`{ account_type }`) at signup,
  then reconciled into a real `automailsend_recruiter_profiles` row on **first login** rather than
  immediately after `signUp()` — a project with email confirmation enabled has no authenticated session at
  the moment `signUp()` resolves, so an insert gated by `auth.uid() = user_id` RLS would fail there; first
  login is the first point a real session is guaranteed. The reconciliation (`page.tsx`'s recruiter-profile
  effect) is idempotent — only creates the row if one doesn't already exist, so every subsequent login is a
  no-op. `RecruiterTab.tsx`'s null-profile branch no longer offers a "Become a Recruiter" button — a
  candidate account just gets a short explanation and a pointer to sign up separately. The sidebar's
  Recruiter tab is still **always visible** to every account (unlike the env-gated Admin tab), so a
  recruiter who signs in lands somewhere real rather than a hidden flag — `page.tsx` also auto-redirects a
  recruiter to `/recruiter` on their very first bare-root (`/`) load, so they don't land on the candidate
  JAMS view by default.
- **First cross-user-visible table in the whole schema.** Every table before this was strictly
  `auth.uid() = user_id` RLS. `automailsend_job_postings` is readable by any authenticated user when
  `status = 'open'`, not just its own recruiter — called out explicitly in the migration's comment. The
  posting-insert RLS policy also now enforces `is_blocked` for the first time on a direct client-side
  write (every other place `is_blocked` matters is a background-worker gate, not RLS).
- **Applications are read-narrow**: a candidate sees only their own; a recruiter sees only applications to
  their own postings, via an RLS subquery against `automailsend_job_postings.recruiter_id`. All inserts go
  through `/api/jobs/apply` (service-role key) rather than a client-side insert — no `insert` RLS policy
  exists for `automailsend_job_applications` at all — because AI-credit spending must be server-verified
  and the candidate-contact/resume snapshot should come from trusted DB reads, not client-supplied copies
  (same reasoning as `/api/ai-enhance`/`/api/resume-import`'s `Authorization: Bearer` → `getAuthedUserId()`
  pattern).
- **Resume attached to an application is a snapshot, not a live reference** — same "snapshot, not FK"
  reasoning as `sent_log`'s `template_label`/`resume_label`. A candidate picks a built resume
  (`ResumeProfile.data`, captured into `resume_data jsonb`) and/or an uploaded file
  (`resume_file_url`/`resume_file_name`), captured at apply time so a later edit/delete never corrupts
  application history.
- **AI-ATS only scores structured resume data**, never an uploaded PDF file — `aiClient.ts`'s
  `serializeResumeForAts()` reduces `ResumeData` to plain text for the Gemini prompt, reusing the same
  "serialize structured data into a prompt" approach already proven elsewhere. A file-only application
  stays unscored (`ai_analyzed_at` null) — same "unknown isn't a fail" precedent as `match_score`. A
  recruiter can trigger scoring later for any unscored application via `ApplicantsModal.tsx`'s "Score with
  AI" button (`/api/jobs/score-application`) — covers both "AI-ATS wasn't on yet" and manual re-scoring.
- **Own AI credit pool**: `automailsend_recruiter_profiles.ats_ai_enabled`/`ats_ai_credits`, fully separate
  from candidate-side `AiConfig`/`ai_credits` — `aiClient.ts` gained a parallel `checkAtsAiGate`/
  `spendAtsAiCredit` pair rather than reusing `checkAiGate`/`spendAiCredit`, since AI-ATS is a different
  feature that shouldn't share one balance even for a user who's both a candidate and a recruiter.
  Admin-granted only, same precedent as candidate `ai_credits` — `AdminPortal.tsx`'s `CreditsCell` now
  takes a `field` prop so the same component drives both columns; `/api/admin/users` merges
  `ats_ai_credits` from the separate table (`null` = not a recruiter, distinct from "recruiter with 0").
- **No backend/worker changes at all** — this whole feature lives in the Next.js app (two new API routes +
  RLS), same as every AI feature since the platform-managed-AI phase. The BullMQ/scheduler backend, which
  auto-deploys to production on every push, is completely untouched.
- **Non-goals this phase** (explicit): no email notifications to a recruiter on new applications, no
  reply-to-applicant messaging from inside the app, no resume-file PDF scoring, no admin moderation queue
  for postings (per the approved answer).
- **Verified**: migration applied + confirmed live (three new tables, all RLS policies, the
  `unique(job_id, candidate_id)` constraint, and the `is_blocked` subquery on the posting-insert policy all
  checked directly against `information_schema`/`pg_constraint`/`pg_policies`), a direct-call test of the
  resume-to-text serialization logic (empty/full/skills-only/malformed resume shapes, no crashes), clean
  `frontend` `npm run build` (including both new `/api/jobs/*` routes), dev server restart with a clean
  log across `/`, `/board`, `/recruiter`, `/admin`. **Not yet live-verified**: no two real accounts exist
  to walk through post → apply → auto-score end-to-end, and no real Gemini key is in place — schema/
  build/syntax-verified only, same standing caveat as every AI-dependent phase this session.

## Profile as knowledge base + per-role module selection + Easy Apply (2026-08-19)
Operator's framing: most candidates target one role, a slight chance of a few — so the **profile** should
be the permanent thing (identity, bio, every experience/education/project/certification/skill they've ever
had), built once and kept current, while a **role** is the thin, disposable layer over it (search criteria
plus which of those profile items apply). "Easy Apply" is the payoff: click it on a Job Board posting, the
app deterministically composes a resume from the matched role's selected modules — no AI needed for that
step, the selection was already made when the role was configured — and hands it to the candidate to
review and send (confirmed with the operator: composes then opens for review, **never auto-submits
silently**).
- **New `automailsend_candidate_profiles` table** (one row per user, mirrors `automailsend_recruiter_
  profiles`'s shape) replaces the old 5-field `CandidateProfile` backed by `automailsend_app_state`
  columns. `education`/`experience`/`projects`/`certifications`/`skills`/`languages` are jsonb arrays of
  objects with a stable `id` — same shape as the Resume Builder's `ResumeData` sub-arrays (`ResumeExperience`
  etc., reused directly), except skills gained an id here (`ProfileSkill = {id, name}`) since a role now
  selects a *subset* of them, unlike a resume's own full copy (`ResumeData.skills` stays plain `string[]`).
  Old `app_state.candidate_*` columns left in place, unused (established precedent). **Consumers updated,
  not left stale**: `automail.worker.js`/`batchSend.worker.js` (the `{{candidate_*}}` template variables)
  and `/api/jobs/apply` (an application's contact-info snapshot) all used to read those app_state columns
  directly — all three now read `automailsend_candidate_profiles` instead, or every automated send and new
  application would have started going out with blank candidate info the moment this shipped.
- **Module selection lives on `RoleDef`** — `selectedExperienceIds`/`selectedEducationIds`/
  `selectedProjectIds`/`selectedCertificationIds`/`selectedSkillIds: string[]`, referencing ids in the
  candidate's profile arrays (`automailsend_role_defs`, jsonb columns). New roles default to **everything
  selected** (`page.tsx`'s `handleAddRole` seeds the arrays from the current profile at creation time) —
  the forgiving default, a candidate trims a role down rather than starting from a resume missing something
  they forgot to add. Also gained `availability` (fixed-option: immediate/2-weeks/1-month/3-plus-months,
  same "fixed context over free text" convention as every other `RoleDef` field). `languages` is
  deliberately not selectable per-role — always carried through whole by `composeResumeData`.
- **`lib/resumeCompose.ts`** — `composeResumeData(profile, roleDef): ResumeData`, a pure function filtering
  the profile's arrays down to each role's selected-id list (an id that no longer exists just drops
  silently — "unknown isn't a fail," same tolerance as everywhere else); `matchRoleToPosting(roleDefs,
  posting): RoleDef | null`, a **no-AI-call** keyword-overlap scorer — single role is always the fast path,
  multiple roles score each one's `keywords` against the posting's title+description and take the highest,
  falling back to the first role rather than null if every score is 0.
- **Profile & Roles merged into one sidebar section** (`page.tsx`'s `profileRolesSubTab`, same pattern as
  the Resumes tab's Files/Builder split) — "My Profile" (`ProfileTab.tsx`, now identity + bio + the five
  section editors) and "Roles" (`JobsRolesTab.tsx`, unchanged content plus `availability` and a
  "Modules for this role" block — five collapsible id-checklists). `ProfileTab.tsx` reuses `ResumeBuilder.
  tsx`'s `ExperienceSection`/`EducationSection`/`ProjectsSection`/`CertificationsSection`/`LanguagesSection`
  verbatim (now exported) — genuinely the same controlled `data`/`onChange` shape over the same item types,
  so duplicating them wasn't worth it. Skills is the one bespoke editor (id-aware, `ResumeBuilder.tsx`'s
  `SkillsSection` isn't reused since it's plain-string, not `ProfileSkill`).
- **Resume Builder gains "New from role"** — a select next to "+ New Resume" that runs
  `composeResumeData` and saves the result as a normal `ResumeProfile`; manual "+ New Resume" (blank) stays
  for anyone who'd rather start from scratch.
- **Job Board gains "⚡ Easy Apply"** next to the existing manual "Apply" — `JobBoardTab.tsx`'s
  `handleEasyApply` runs `matchRoleToPosting` → `composeResumeData` → saves/updates a `ResumeProfile`
  labeled `"<Role> — Easy Apply"` (repeat clicks for the same role update in place, not duplicate) → opens
  the existing `ApplyModal` pre-selected on it with a "Using your '<Role>' profile" note. No changes needed
  to `/api/jobs/apply` itself — it already accepted a `resumeProfileId`; Easy Apply just prepares one.
- **Verified**: migration applied + confirmed live (new table + RLS, new `role_defs` columns, checked
  against `information_schema`/`pg_policies`); a direct-call test of `composeResumeData` (selected-subset
  filtering across all five sections, stale-id tolerance, empty-selection) and `matchRoleToPosting`
  (single-role passthrough, multi-role keyword scoring, zero-score fallback, zero-role → null); clean
  `frontend` `npm run build`; `node --check` on the two edited backend workers; dev server restart with a
  clean log across `/`, `/profile`, `/board`, `/login`, `/signup`. **Not yet live-verified**: no real
  profile has been filled in and walked through Easy Apply end-to-end against a real posting.
- **Simplified from the original plan**: profile edits don't retroactively auto-append new items into
  already-configured roles' selections — only role *creation* defaults to "everything selected." Adding
  that later would mean diffing the whole profile on every edit for a corner case (most candidates build
  their profile before creating roles, per the operator's own framing); flagged rather than silently
  dropped.

### Follow-up (same day) — separate tabs again, markdown-lite description fields
Two operator refinements right after the above shipped:
- **Profile and Roles are two sidebar tabs again**, not one section with an internal toggle — easier
  navigation was the explicit reason. `page.tsx`'s `profileRolesSubTab` state and its toggle buttons are
  gone; `TAB_NAMES` has `'profile'` and `'roles'` as separate entries again, each with its own sidebar
  button and `activeTab` render branch. No data/prop changes — `ProfileTab`/`JobsRolesTab` themselves are
  untouched by this part.
- **Experience/project descriptions and education notes are now one markdown-lite text block each**,
  replacing the old bullets-as-separate-inputs editor (`BulletsEditor`, removed). `ResumeExperience.
  bullets: string[]` became `description: string`; `ResumeProject` dropped its separate `bullets` array
  (absorbed into its existing `description` field); `ResumeEducation.notes` kept its name but gained the
  same rich editor. The syntax is deliberately tiny, not CommonMark — only what the operator asked for: a
  line starting with `- ` or `* ` is a bullet point, `**text**` is bold. New `lib/markdownLite.tsx`'s
  `renderMarkdownLite(text)` parses it into JSX (used by `ModernTemplate.tsx`/`ClassicTemplate.tsx`'s
  preview/PDF output); the editing side is `ResumeBuilder.tsx`'s new `MarkdownLiteField` — one
  `AutoGrowTextarea` plus a `HoverHint` (new, `components/HoverHint.tsx` — a pure-CSS hover popover,
  deliberately distinct from `HelpTooltip.tsx`'s click-to-open modal, since a syntax reference should show
  on hover mid-typing, not demand a click) showing the two rules with a rendered example. `ProfileTab.tsx`
  inherits all of this for free since it reuses `ResumeBuilder.tsx`'s section editors verbatim (see above).
  **Consumers updated, not left stale**: `aiClient.ts`'s `RESUME_IMPORT_SYSTEM_PROMPT` (tells Gemini to
  emit `description`/`notes` as one string with `- ` bullet lines instead of a `bullets` array) and
  `serializeResumeForAts()` (reads `e.description` instead of iterating `e.bullets`) both updated — missing
  either would have silently broken AI resume import or fed empty experience content into AI-ATS scoring.
- **Verified**: clean `frontend` `npm run build`, a direct-call test of the markdown-lite block-grouping
  logic (consecutive bullets group into one list, mixed prose/bullets/prose, blank-line handling, inline
  bold parsing — all passed), dev server restart with a clean log across `/profile`, `/roles`, `/`,
  `/board`, `/resumes`.

### Follow-up (same day) — comma-split skills, quick-add from Roles, select all/none
Operator report after actually using My Profile ("saves right away, works very smoothly") plus three asks:
- **Skills input splits on commas** — typing/pasting "React, Node.js, PostgreSQL" adds three skills, not
  one literal chip containing commas. `ProfileTab.tsx`'s `addSkill()` and `ResumeBuilder.tsx`'s
  `SkillsSection`'s `add()` (the plain-`ResumeData.skills` version, for a manually-built resume) both do
  this now — split on `,`, trim, dedupe case-insensitively both within the pasted batch and against what's
  already there.
- **New `components/AddProfileItemModal.tsx`** — a floating "+ Add experience/education/project/
  certification" modal, opened from the Roles tab's module checklists, with the same fields as
  `ResumeBuilder.tsx`'s section editors (one entry at a time, not a full list manager). Submitting writes
  straight into the *same* canonical `CandidateProfile` state `ProfileTab` edits (new `onProfileChange`
  prop on `JobsRolesTab`, wired to the same `setProfile` page.tsx already passes to `ProfileTab` — there's
  only ever one copy of this data, so nothing needs separate syncing) and auto-selects the new item for
  whichever role was open when it was added — a candidate adding a forgotten experience mid-role-setup
  never has to context-switch to My Profile and back. Skills get a lighter inline "add skill(s)" input
  next to the Skills checklist instead of a modal (one field didn't warrant a popup); Languages isn't part
  of this (never was module-selectable — see the phase above).
- **Select all / Select none** on every module checklist (`ModuleChecklist` in `JobsRolesTab.tsx`) —
  mainly useful after trimming a role down, or after a batch of quick-adds, to restore/clear a whole
  section in one click rather than checking each box.
- **Verified**: clean `frontend` build, direct-call tests of the comma-split/dedup logic (whitespace,
  trailing commas, within-batch and against-existing dedup) and select-all/none semantics, dev server
  restart clean across `/profile`, `/roles`, `/`, `/board`, `/resumes`. **Not verified**: no real click-
  through of the new modal or inline skill adder in an actual browser session.

## Email Templates redesign — three send modes, per-template resume/attachments (2026-08-19)
Operator ask: remove randomization entirely (it "won't make any sense" once a role can just pick a mode)
and replace it with an explicit choice — hand-pick one template, let AI pick among your own unedited
templates (cheap, no hallucination risk since the AI never writes anything), or bypass templates
completely and let AI write the email from scratch. Attachments move from a separate, per-role rotating
"Resumes" library onto each template itself (its own resume + its own "other" files), with a global
default any template can opt into instead of re-adding the same file everywhere.

**Send mode lives on the role, not a template** (`RoleDef.emailSendMode: "manual" | "ai-select" |
"ai-write"`, `RoleDef.selectedTemplateId`) — a role already owns its own template pool (role-tabbed in
`RoleTemplates.tsx`) and a role is what a job posting matches against, so the mode describes *how this
role's outreach gets composed*, not a property of one template row.
- **`manual`** — always sends `selectedTemplateId`, explicitly chosen (a radio next to each template
  card, replacing the old "Set default"). Stale/deleted id → treated as "none selected" (unknown isn't a
  fail — same tolerance used throughout this project), recipient skipped with a clear log line rather than
  guessed. 0 AI credits.
- **`ai-select`** — new `chooseTemplateForJob(templates, roleLabel, contextText, temperature)` in
  `ai.service.js` (mirrors `scoreJobMatch`'s shape): a classification call over the role's own
  user-written templates (id/label/subject/first ~200 chars of each), returns which one best fits the job.
  The templates themselves are never rewritten — only *which one* is chosen — so there's no hallucination
  risk in the actual sent content, and it's the same 1-credit cost as any other AI call but a much smaller,
  cheaper prompt than full generation. A single-template pool skips the AI call entirely (nothing to
  choose between). Falls back to the pool's first template if AI is off/out of credits/errors.
- **`ai-write`** — bypasses templates entirely. Reuses `generateAiPersonalizedEmail`/
  `JOB_APPLICATION_SYSTEM_PROMPT`, but `baseTemplate` is now optional — `null` for this mode, and the
  prompt explicitly instructs the model to write fully from candidate info + contact info + job post alone
  when it's absent (previously `baseTemplate` was always a template, used as a loose style reference; this
  makes the "no template" case a real, first-class path instead of implicit). No template to fall back to
  if AI is unavailable, so the recipient is skipped with a clear log line rather than sent something
  broken — same hard-guardrail spirit as the existing unresolved-`{{...}}` block.
- The AI tab's global enable toggle + credit balance stay the master switch/wallet (unchanged); per-role
  mode decides whether/how that capability gets used for that role's sends. The **old, always-on**
  "personalize everything if AI is globally enabled" behavior is gone — content resolution is now fully
  determined by the role's mode, no separate blanket toggle layered on top of template picking.

**Per-template resume + attachments** — `RoleTemplate` gained `resumeSource: "none" | "file" | "builder"`,
`resumeFile`/`resumeProfileId`/`resumeProfileSnapshot`, `useGlobalResume`, `useGlobalFiles`. `files`
(unchanged) is "other" attachments — portfolio, images, etc. — separate from the resume slot.
- **"Use the Cuneihire Resume Builder"**: pick a saved `ResumeProfile`, click "Generate PDF". New
  `frontend/src/lib/resumePdf.tsx`'s `useResumeProfilePdf()` hook extracts the html2canvas+jsPDF pipeline
  that used to live only in `ResumeBuilder.tsx`'s "Save to Library" button (now removed — that whole
  library concept is gone, see below) into a reusable piece: it renders the chosen profile's template
  component (`ModernTemplate`/`ClassicTemplate`) into an **off-screen** host (`position: absolute; left:
  -9999px` — needs real layout for `html2canvas` to measure, so hidden via `visibility`/`display` wouldn't
  work) since neither consumer (a template's own editor, the new global panel) has a live preview mounted
  the way the Builder does. Explicit, user-triggered generation only — a `🔄 Regenerate` button covers the
  source profile changing later (same "snapshot, not live FK" precedent as `SentRecord.templateLabel`/
  `JobApplication.resumeData` — it does not auto-update).
- **Global defaults ("somewhere else," per the operator) — the old "Resumes" tab's "Files" sub-view is
  repurposed.** It used to be a per-role, randomized resume FILE library (`automailsend_resumes`,
  `ResumeEntry`); that whole concept is superseded by each template owning its own resume slot. The panel
  is now **Global Resume & Files**: one global resume (same file-or-builder choice, `CandidateProfile`'s
  new `globalResumeSource`/`globalResumeFile`/`globalResumeProfileId`/`globalResumeProfileSnapshot`) + one
  global "extra files" list (`globalFiles: Attachment[]`) — set once, permanent-profile-style (matches the
  operator's own Phase B framing of what belongs on the profile vs. a role). Each template gets two
  checkboxes: "Use global resume" (its own resume config is ignored when checked) and "Use global files"
  (additive — attached *alongside* the template's own `files`, not instead of). A role in `ai-write` mode
  has no template at all, so it **always** uses the global resume + global files — the case "global" exists
  for. `automailsend_resumes` and `ResumeEntry` are left in place, unused by this redesign — but
  `JobBoardTab.tsx`'s manual Apply-flow resume-file picker is a genuinely separate, untouched consumer of
  that same table (out of this plan's scope), so the load path stays wired; only the *write* path (the old
  ResumesTab UI, `ResumeBuilder.tsx`'s "Save to Library" button) was removed.

**Resolution — shared, not duplicated per worker**: new `backend/src/lib/emailResolve.js`
(`resolveAttachments`/`describeResumeSource`, pure functions over raw DB rows) and its frontend mirror
`frontend/src/lib/emailResolve.ts` (camelCase, used by `QuickSendModal.tsx`'s synchronous client-side send
path — same "keep in sync" duplication as `crypto.ts`/`.js`) replace `pickFromPool()`
(`backend/src/lib/templatePicker.js`/`frontend/src/lib/templatePicker.ts`, both **deleted**, no consumers
left). `automail.worker.js`/`batchSend.worker.js` now fetch `role_defs` (mode + selected template) instead
of the old per-role resume-array fetch, and resolve mode/template/attachments per recipient inline (kept
inline rather than extracted further, since credit-spend/logging differ meaningfully between the two
workers' existing idioms).

**Quick Send** (`QuickSendModal.tsx`): `Auto` now means "follow this role's configured send mode" — which,
concretely, means the role's `selectedTemplateId` (or the pool's first template) directly, deterministic,
no re-roll. `ai-select`/`ai-write` aren't invoked here even for a role configured that way — Quick Send is
a manually-added, one-off HR contact with no scraped job post `context_text` for either mode to work from,
so a hint under the picker explains the role's real mode is being bypassed for this one send. The old
separate Resume picker is gone — attachments resolve from `lib/emailResolve.ts`'s `resolveAttachments`
against whichever template is in play.

**JamsTab's bulk-send dialog** dropped its "AI personalize / Template" mode picker
(`config.batchMode`/`SmtpConfig.batchMode`) — one "Send Selected"/"Send" button now, since that choice is
made once per role, not re-picked per bulk-send. `batchSend.worker.js` no longer reads `config.batchMode`.
Its pre-send check ("does this role have a template?") is now mode-aware — a role in `ai-write` mode needs
none at all.

**Naming**: sidebar/panel label changed "Templates" → "Email Templates"; component file/route key
(`RoleTemplates.tsx`, `templates`) unchanged — same "rename the label, not the file" call as `JobsRolesTab`
becoming "Roles" in Phase C.

**Files touched**: schema (both `supabase_setup.sql` copies, section 28); `types.ts` (`EmailSendMode`,
`EMAIL_SEND_MODES`, `RoleDef.emailSendMode`/`selectedTemplateId`, `ResumeAttachmentSource`,
`RoleTemplate`'s new fields, `CandidateProfile`'s `global*` fields); `storage.ts` (mapping/save for all of
the above); new `lib/resumePdf.tsx`, `lib/emailResolve.ts`; deleted `lib/templatePicker.ts`; `RoleTemplates.tsx`
(major rewrite), `ResumesTab.tsx` (repurposed), `ResumeBuilder.tsx` (library-save path removed),
`QuickSendModal.tsx`, `JamsTab.tsx`, `page.tsx` (wiring); backend `services/ai.service.js`
(`chooseTemplateForJob`, optional `baseTemplate`), new `lib/emailResolve.js`, deleted
`lib/templatePicker.js`, `workers/automail.worker.js`/`workers/batchSend.worker.js`.

**Verified**: migration applied + verified live (13 new columns across 3 tables, correct defaults);
direct-call tests of `resolveAttachments`/`describeResumeSource` (the real backend module, not a mirror —
plain JS, no DB calls) covering the manual/global/ai-write/nothing-configured matrix, and a mirror of
`chooseTemplateForJob`'s response-validation branches (empty pool, single-template short-circuit, valid/
invalid/malformed AI response); clean `frontend` `npm run build`; backend `node --check` + a plain
`require()` load of every touched backend module; lint checked for no *new* issues in touched files (one
genuinely-new item, an unused `useMemo` import left over in `ResumeBuilder.tsx`, was fixed; everything else
flagged matches this project's established pre-existing patterns — `catch (e: any)`, the
`useEffect(() => setMounted(true), [])` SSR-guard idiom, `mapXRow(x: any)` row mappers); dev server restart,
clean log across `/templates`, `/resumes`, `/roles`, `/emails`, `/`. **Not verified**: no real Gemini key
exists, so `chooseTemplateForJob` and the `ai-write` path are untested against the real API (standing
caveat for every AI feature this session); no real click-through of the new per-template resume picker,
the Global Resume & Files panel, or a generated PDF's actual visual output, in an actual browser session.

### Follow-up (same day) — attachments moved from per-template/global to a role-level module selection; "ai-write" dropped
Operator feedback right after the phase above shipped, two corrections:

1. **Attachments are a role-level module selection, not a per-template config or a single "global
   default."** The per-template resume slot + "use global resume/files" checkboxes (previous section)
   were retired the same day — a role now selects which of the candidate's files apply to it
   (`RoleDef.selectedFileIds`), exactly the same pattern as `selectedExperienceIds`/`selectedEducationIds`/
   etc., not a fixed default applied everywhere. The operator's framing: "global" means shared storage
   reusable across roles without re-uploading, never "the same file for every role" — a role's selection
   is what applies to every job matched to that specific role.
   - `CandidateProfile.globalResumeSource`/`globalResumeFile`/`globalResumeProfileId`/
     `globalResumeProfileSnapshot`/`globalFiles` collapsed into one unified `CandidateProfile.files:
     Attachment[]` — a resume is now just another file (tagged via `Attachment.sourceResumeProfileId`
     when generated from a Resume Builder profile, for the "🔄 Regenerate" action), not a separate
     special-cased slot, per the operator's "have the resume as an additional file for the roles."
   - `RoleTemplate` lost `resumeSource`/`resumeFile`/`resumeProfileId`/`resumeProfileSnapshot`/
     `useGlobalResume`/`useGlobalFiles` entirely — a template is purely its wording again (label/subject/
     content), same shape as before the redesign. `RoleTemplate.files` (the older, pre-2026-08-19 "other
     attachments" field) is left in the type/schema but no longer actively used — attachments are 100%
     role-level now.
   - The "somewhere else" the files pool lives is **My Profile**, not the Resumes tab — a new "Files"
     `FormSection` in `ProfileTab.tsx` (upload directly, or generate from a saved Resume Builder profile),
     alongside Experience/Education/Projects/Certifications/Skills/Languages. `ResumesTab.tsx` is
     **deleted** (its whole purpose is absorbed — same "component deleted, not just deprecated" precedent
     as JamsTab absorbing the old RecipientManager/SendPanel/QuickSendTab); the "Resumes" sidebar tab is
     now just the Builder directly, no more Files/Builder sub-tab toggle.
   - `JobsRolesTab.tsx` gained a 6th `ModuleChecklist` ("Files", sourced from `profile.files`) alongside
     the existing five, plus an inline "+ Upload file" / "Generate from Resume Builder" quick-add — same
     pattern as the experience/education/etc. quick-adds, writing into the canonical profile and
     auto-selecting for the currently-open role.
   - Schema: only one new column needed (`automailsend_role_defs.selected_file_ids`) —
     `automailsend_candidate_profiles.global_files` is **repurposed** (not renamed) as the unified files
     pool, since it already held the right `Attachment[]` jsonb shape; `automailsend_templates`'s
     resume_*/use_global_* columns are dropped from active use (left in place, unused, same
     superseded-not-dropped precedent as everywhere else).
   - Both workers' attachment resolution simplified to match: `resolveAttachments(template, profile)` →
     `resolveRoleFiles(roleDef, profile)` in `lib/emailResolve.js`/`.ts` — filters the profile's files pool
     by the role's `selected_file_ids`, independent of send mode (manual and ai-select now resolve
     attachments identically, since there's no more "no template" case to special-case around).

2. **"Let AI write my mail" (the third, template-free send mode) is dropped — back to two modes.** Operator:
   "we will have only two options: manual pick[, and let AI choose]" — `EmailSendMode` is now `"manual" |
   "ai-select"` only; `EMAIL_SEND_MODES`' copy was also tightened ("we need to have it more user-friendly")
   though a fuller UI/UX pass is explicitly deferred by the operator to later. Both workers' `ai-write`
   branches (the `generateAiPersonalizedEmail(..., null, ...)` call, the `shouldSkip`/`skipReason`
   plumbing that only existed to support it) are removed — content resolution is back to always
   "resolve a template, fill in its placeholders," never a full AI rewrite in the background-send path.
   `chooseTemplateForJob` (ai-select) is unaffected — still a classification call only, never rewrites.
   `ai.service.js`'s `JOB_APPLICATION_SYSTEM_PROMPT`/`buildUserMessage` "optional baseTemplate" wording
   (added for ai-write) was reverted back to always-required, since nothing calls it with `null` any more;
   `generateAiPersonalizedEmail` itself is left exported/functional but currently has no caller — same
   "leave the capability, don't delete a tested function" reasoning as other retired-but-recoverable code
   this session, in case the operator wants it back.

**Files touched**: `types.ts` (`Attachment.sourceResumeProfileId`, `EmailSendMode` trimmed to 2,
`RoleDef.selectedFileIds`, `RoleTemplate`/`CandidateProfile` reshaped, `ResumeAttachmentSource` removed),
`storage.ts` (mapping for all of the above), `lib/emailResolve.ts`/`.js` (rewritten around
`resolveRoleFiles`/`describeFiles`), `ProfileTab.tsx` (new Files section), `JobsRolesTab.tsx` (6th
checklist + quick-add), `RoleTemplates.tsx` (attachment UI removed entirely), `ResumesTab.tsx` (deleted),
`QuickSendModal.tsx`, `JamsTab.tsx`, `page.tsx` (wiring — Resumes tab simplified to just the Builder);
backend `services/ai.service.js` (baseTemplate reverted to required), `workers/automail.worker.js`/
`workers/batchSend.worker.js` (ai-write branch removed, attachment resolution simplified).

**Verified**: migration applied + verified live (one new column, `selected_file_ids`); direct-call tests
of the real `resolveRoleFiles`/`describeFiles` (subset-per-role, a different role gets a different subset
of the same pool, empty selection, null roleDef/profile, stale file id all covered); clean `frontend`
`npm run build`; backend `node --check` + `require()` load of every touched module; lint checked for no
new issues; dev server restart, clean log across `/profile`, `/roles`, `/templates`, `/resumes`,
`/emails`, `/board`, `/`. **Not verified**: no real browser click-through of the new Files section on My
Profile, the Roles tab's Files checklist/quick-add, or a generated PDF's actual output.

### Follow-up (2026-08-20) — resume/file UI consolidated onto the Resumes tab
Operator: "keep all the resume settings in the resume section and just create different tabs, like one
for the builder tab and one for the configuration tab." Pure UI relocation — the data model/hierarchy from
the follow-up above is unchanged (`CandidateProfile.files` is still the one shared pool, `RoleDef.
selectedFileIds` is still each role's own subset); only where the controls live moved.

- New `ResumeConfigTab.tsx` is the "Configuration" sub-tab. Two sections: **Your Files** (upload / generate
  from a saved Resume Builder profile / preview / regenerate / delete — the exact block that had been on
  `ProfileTab.tsx`, moved verbatim) and **Which files apply to each role** (a small role-tab bar sharing
  `activeTemplateRole` — the same role-key state Roles and Email Templates already share — plus a plain
  checkbox list with select-all/none against the active role's `selectedFileIds`, replacing the "Files"
  `ModuleChecklist` entry that had briefly lived on `JobsRolesTab.tsx`). Uploading/generating still
  auto-selects the new file for whichever role tab is active, preserving the "add it here, don't leave the
  page" convenience the old Roles-tab quick-add had.
- `page.tsx`'s `resumes` tab now renders both a heading and a `btn primary`/`btn ghost` two-way sub-tab
  switcher (local `resumeSubTab` state, not persisted, always opens on Builder) above either the unchanged
  `ResumeBuilder` or the new `ResumeConfigTab`.
- `ProfileTab.tsx` and `JobsRolesTab.tsx` both lost their Files UI and the `userId`/`resumeProfiles` props
  that existed only to support it — same "remove the prop once its only consumer is gone" discipline as
  `ResumeBuilder.tsx`'s `userId` removal earlier this project. `JobsRolesTab`'s `SelectionField` union
  dropped `"selectedFileIds"`.
- `RoleTemplates.tsx`'s hint copy/comments repointed from "the Roles tab's Files checklist" to "the Resumes
  tab's Configuration sub-tab."

**Files touched**: new `ResumeConfigTab.tsx`; `ProfileTab.tsx` (Files section + now-unused props removed),
`JobsRolesTab.tsx` (Files checklist/quick-add + now-unused props removed), `RoleTemplates.tsx` (comment/
hint text only), `page.tsx` (sub-tab switcher + wiring). No schema, types, or backend changes.

**Verified**: clean `npm run build` (first try); lint re-checked (only the pre-existing `catch (e: any)`
pattern already used throughout the codebase, and the pre-existing set-state-in-effect warnings — nothing
new); dev server killed/`.next` cleared/restarted, all 7 touched routes (`/`, `/profile`, `/roles`,
`/resumes`, `/templates`, `/emails`, `/board`) returned clean 200s with no error-level log lines.
**Not verified**: no real browser click-through of the new Builder/Configuration sub-tabs.

### Follow-up (2026-08-20) — Email Templates split into Templates/Configuration; "let AI write it" restored
Operator: Templates sub-tab first, Configuration second; Configuration holds three send-mode options —
manual, "let AI choose," and "let us write the whole email." The third is a straight reversal of the
2026-08-19 decision to drop it — nothing at the data layer needed undoing, since `generateAiPersonalizedEmail`
was deliberately left exported and working "in case the operator wants it back" when it was dropped; that
bet paid off here.

- `EmailSendMode` is `"manual" | "ai-select" | "ai-write"` again; `EMAIL_SEND_MODES` has all three, the
  third labeled "Let AI write it."
- New `EmailConfigTab.tsx` is the "Configuration" sub-tab: a role-tab bar (sharing `activeTemplateRole`,
  same state Roles/Templates/Resumes-Configuration all share) + the mode radios, moved verbatim out of
  `RoleTemplates.tsx`. `RoleTemplates.tsx` now owns only template wording — list + editor, no mode
  selector — and lost its own outer `.panel`/`.panel-head`, since `page.tsx` now wraps both sub-tabs in
  one shared panel with a `btn primary`/`btn ghost` switcher (`templatesSubTab`, not persisted, opens on
  Templates) between the heading and the sub-tab content, mirroring the Resumes tab's Builder/Configuration
  split from earlier the same day.
- `ai.service.js`: `buildUserMessage`'s `baseTemplate` param is optional again — `null` renders an explicit
  "None — write the email entirely in your own words" block in the prompt instead of throwing on
  `baseTemplate.subject`. `generateAiPersonalizedEmail` (already exported, previously uncalled) is wired
  back into both workers.
- `automail.worker.js`/`batchSend.worker.js`: both regained an `ai-write` branch — no template resolved at
  all; calls `generateAiPersonalizedEmail(candidateInfo, recipient, contextText, null, profile,
  temperature)`, handles the model's `{skip:true,reason}` shape the same way `ai-write` did originally,
  spends 1 AI credit on success, and skips the recipient with a clear log line (not a broken send) when AI
  is off or out of credits. Fixed in passing: `batchSend.worker.js` used to bail the *entire batch* if the
  templates table was empty — wrong once a role can legitimately have zero templates (ai-write mode) —
  now that check is gone; an empty per-role pool only skips that recipient, in manual/ai-select modes.
- `JamsTab.tsx`'s pre-bulk-send "does this role have templates" check regained its `mode !== "ai-write"`
  exemption. `QuickSendModal.tsx`'s "auto" hint text now treats ai-write the same way it already treated
  ai-select: Quick Send has no scraped job post for AI to write from, so it deterministically falls back
  to the role's template instead.
- Schema: **no migration** — `role_defs.email_send_mode` has always been a plain `text` column with no
  CHECK constraint restricting its values, so the third value needed no schema change to become legal
  again.

**Files touched**: `types.ts` (`EmailSendMode` + `EMAIL_SEND_MODES`, comments), new `EmailConfigTab.tsx`,
`RoleTemplates.tsx` (mode selector removed, outer panel removed), `page.tsx` (sub-tab switcher + wiring);
backend `ai.service.js` (`baseTemplate` optional again), `automail.worker.js`/`batchSend.worker.js`
(ai-write branch restored, batchSend's empty-templates-table early return removed), `JamsTab.tsx`,
`QuickSendModal.tsx` (hint text).

**Verified**: clean `frontend` build; lint re-checked (nothing new); backend `node --check` + `require()`
load of both workers and `ai.service.js` with `.env` present; confirmed
`generateAiPersonalizedEmail(..., null, ...)` no longer throws synchronously on the null `baseTemplate`
(fails only at the expected "no `GEMINI_API_KEY` locally" point — same standing caveat as every AI feature
this session); dev server restart, clean 200s on `/templates`, `/roles`, `/emails`, `/`. **Not verified**:
no real Gemini key, so the actual ai-write generation call is untested against the live API; no browser
click-through of the new Templates/Configuration sub-tabs.

### Follow-up (2026-08-20) — resume hierarchy: one resume per role, with a global default
Operator: "how many times can you possibly build one resume for one role?" — the flat `selectedFileIds`
subset (previous follow-up) didn't distinguish a resume from a portfolio file, and a role could end up
with any number of resume-shaped files selected at once. New hierarchy: `CandidateProfile.globalResumeId`
is the top (a single default resume every role inherits automatically); `RoleDef.resumeId` is a role's own
override (`null` = inherit global); `RoleDef.selectedFileIds` narrows in meaning to "additional files"
alongside that one resume. Both new fields are just `Attachment.id` pointers into the existing shared
`files` pool — no new storage mechanism, no FK (an id into a jsonb array has no table row to reference),
same tolerant "unknown id resolves to nothing" pattern as `selectedFileIds`/`selectedTemplateId`.

- `lib/emailResolve.js`/`.ts` rewritten: `resolveRoleResume` (role override, else global default, else
  none), `resolveRoleAdditionalFiles` (unchanged old logic), `resolveRoleAttachments` → `{resume,
  additionalFiles, all}` — `all` (resume first, then additional files, de-duped by id) is what every
  consumer attaches. Old `resolveRoleFiles` removed; both workers and `QuickSendModal.tsx` switched to
  `resolveRoleAttachments(...).all`. Both workers' selects extended (`resume_id` on `role_defs`,
  `global_resume_id` on `candidate_profiles`).
- `ResumeConfigTab.tsx`: new "Global default resume" picker (single `<select>` from the pool, writes
  `profile.globalResumeId`); the per-role section gained a "Resume for {role}" `<select>` (first option
  "Use global default", then every pool file as an explicit override) with its own dedicated "+ Upload new
  resume"/"Generate from Resume Builder" actions that set `resumeId` directly (not `selectedFileIds`);
  the additional-files checklist below it now excludes whichever file is the role's current resume (own or
  inherited) — picking a file as the resume also removes it from that role's `selectedFileIds` if it was
  there, so nothing looks double-selected (the resolver's de-dupe is a safety net regardless, not the only
  guard).
- New-role default: `handleAddRole` in `page.tsx` needed no change — omitting `resumeId` already resolves
  to `null` via `saveRoleDef`'s existing `??` fallback, which is exactly "inherit the global default."
- **Explicitly deferred, not built this pass** (operator raised both as context, said to do the
  one-resume-per-role piece first): an AI-generated tailored resume per application as a third resume
  *source* alongside upload/Builder, and improving the Resume Builder itself.

**Files touched**: backend `lib/emailResolve.js` (rewritten), `workers/automail.worker.js`/
`batchSend.worker.js` (new resolver, extended selects); frontend `types.ts` (`RoleDef.resumeId`,
`CandidateProfile.globalResumeId`), `storage.ts` (mapping), `lib/emailResolve.ts` (mirrored rewrite),
`ResumeConfigTab.tsx` (global picker + per-role resume single-select + narrowed additional-files list),
`QuickSendModal.tsx` (new resolver); both `supabase_setup.sql` copies (section 30).

**Verified**: migration applied + verified live (two new columns); 11 direct-call assertions against the
real `emailResolve.js` (role override beats global, falls back to global when unset, both unset → no
resume, stale/unknown ids on either → nothing, not a crash, null roleDef/profile handled gracefully,
additional files resolve independently, combined `all` list is resume-first and de-duped); clean
`frontend` build; lint checked for no new issues; backend `node --check` + `require()` load of every
touched module; dev server restart, clean 200s on `/resumes`, `/roles`, `/templates`, `/`. **Not
verified**: no real browser click-through of the new global/per-role resume pickers.

### Follow-up (2026-08-20) — resume default source: build from profile, upload demoted to override
Same-day follow-up to the hierarchy above. Operator: a role already hand-picks its own profile subset
(`RoleDef.selectedExperienceIds` etc., set on the Roles tab), so a resume filtered to exactly that subset
should be the *default* way a role gets its resume — not a separate upload/Builder round-trip that has to
be found and picked afterward. "Cut out all other data" = the built resume must contain only what's
selected for that role, never the candidate's whole profile.

No schema change and no backend change — Phase E's hierarchy (`globalResumeId`/`resumeId`/
`resolveRoleAttachments`) is reused exactly as-is; only *how* `RoleDef.resumeId` gets populated changed.

- New `ResumeConfigTab.tsx` handler `handleBuildResumeFromProfile()` composes-and-attaches by chaining two
  pieces that already existed for other purposes: `lib/resumeCompose.ts`'s `composeResumeData(profile,
  roleDef)` (already used by the Resume Builder's "New from role" — filters the profile down to the role's
  selected experience/education/projects/certifications/skills) into `lib/resumePdf.tsx`'s
  `useResumeProfilePdf().generate(...)` (already used by every other resume-PDF generation path — takes any
  `ResumeProfile`-shaped object, so a throwaway `{id: "auto", label, templateId: "modern", data}` works
  without persisting a `ResumeProfile` row). The result is tagged with a new `Attachment.sourceRoleId`
  (parallel to the existing `sourceResumeProfileId`, which marks "generated from a saved Builder profile"
  instead) and set as the role's `resumeId` via the existing `handleRoleResumeChange`.
- Refresh, not duplicate: if the role's current resume already carries `sourceRoleId === this role's id`,
  clicking again replaces that same pool entry in place (deletes the old storage file, same pattern as the
  existing per-file "🔄 Regenerate") instead of accumulating a new file on every click.
- UI: the per-role section now shows "Build my resume from profile" (or, once one exists, "🔄 Refresh from
  profile") first — the new default path — with the existing upload/pick-a-file `<select>` + quick actions
  demoted below it under "Or use your own file". Existing roles that already had an override set from
  Phase E are unaffected; they just render as today's picker's current selection.
- **Still deferred, unchanged from Phase E**: an AI-generated tailored resume per application, and
  improving the Resume Builder itself.

**Files touched**: frontend only — `types.ts` (`Attachment.sourceRoleId`), `ResumeConfigTab.tsx` (new
handler + reordered per-role UI). No backend, no schema, no migration.

**Verified**: clean `frontend` build; lint shows only the file's pre-existing `catch (e: any)` pattern
repeated once more (not a new issue class); dev server restart, clean 200s on `/resumes`, `/roles`,
`/templates`, `/`. **Not verified**: no real browser click-through of the new build/refresh buttons.

### Follow-up (2026-08-20) — Resume Builder redesign: role-tabbed, three modes, sync-back-to-profile
Same-day follow-up to both entries above. Operator's read on the old Builder tab: "full of shit" — a flat
`ResumeProfile` dropdown, "+ New Resume", a separate "New from role…" dropdown, an AI import button, a
template picker, all in one toolbar with no per-role structure. Wanted instead: role tabs (matching Roles/
Email Templates/Resumes-Configuration) and, per role, exactly three modes.

- **"profile" (default)** — composed live from `lib/resumeCompose.ts`'s `composeResumeData(profile,
  roleDef)`, editable in the same form+preview the builder already had. Deliberately **ephemeral until
  Save** — no new persistence table; edits live in a `Record<roleId, ResumeData>` at the `ResumeBuilder`
  component level (survives switching role tabs within a visit, lost on navigating away — nothing hits the
  DB until Save). Saving diffs the draft against a *freshly recomputed* baseline
  (`lib/resumeSync.ts`'s `diffResumeAgainstProfile` — new items not in the profile, edited existing items,
  new/renamed skill names, changed summary/identity fields) and, only if something changed, shows a new
  `SyncResumeModal.tsx` offering **"Save to Profile & Role"** (`lib/resumeSync.ts`'s
  `mergeResumeIntoProfile` — appends new items and selects them for this role, overwrites edited items in
  place by id, new skill names become new `ProfileSkill`s, summary → `bio`, identity fields sync if
  changed; **never removes anything**, even an item the draft dropped — same "forgiving default, don't
  destroy shared data from a per-view action" precedent as everywhere else) or **"Just this resume"**
  (skip the merge, the edit stays local to this one PDF). Either choice then renders+uploads via the
  existing `lib/resumePdf.tsx`'s `useResumeProfilePdf`, tagged `Attachment.sourceRoleId`, replacing this
  role's previous profile-sourced attachment in place rather than duplicating — the same underlying action
  the previous follow-up's `handleBuildResumeFromProfile` did (that handler is gone; this Save flow
  supersedes it). Both `onProfileChange`/`onUpdateRoleRules` are called **exactly once each** per save,
  combining every change into a single patch — calling either setter twice in one handler risks the second
  call clobbering the first with a stale closure, since React hasn't re-rendered with the new props yet.
- **"scratch"** — today's original blank-builder behavior, zero profile linkage, ever. Scoped to a role via
  new `RoleDef.scratchResumeProfileId` (a plain pointer into the existing, unchanged
  `automailsend_resume_profiles` table) instead of picking from a flat list — reopening the pill resumes
  the same draft. The AI "✨ Import from a resume" action moved here from the old always-visible toolbar
  (capability kept, just relocated to where it's actually relevant).
- **"upload"** — unchanged Phase-E override path (`RoleDef.resumeId` set directly to an uploaded
  `Attachment`), moved out of `ResumeConfigTab.tsx`'s per-role section into this tab.
- **Consolidation**: `ResumeConfigTab.tsx` is trimmed to candidate-level only — "Your Files" pool and the
  "Global default resume" picker. All per-role resume authoring/attachment selection (including the
  additional-files checklist) now lives on the Builder tab's role view, one place instead of two competing
  UIs for the same setting.
- **No schema change to `automailsend_resume_profiles`**, and no backend/worker change at all —
  `resolveRoleResume`/`resolveRoleAttachments` are untouched; a role's resume is still whatever
  `resumeId` points at, regardless of which mode produced it. `JobBoardTab.tsx`'s Easy Apply and
  `ApplyModal` both depend on `resumeProfiles` staying a flat, freely-labeled list — confirmed by reading
  that file before designing this, left completely alone. Trade-off: Easy-Apply-generated resumes aren't
  browsable from the redesigned Builder tab anymore (no `scratchResumeProfileId` link), only via Job Board
  itself — matches the "cut the clutter" intent, flagged in case it's unwanted.
- **Known edge cases, accepted by design** (see `lib/resumeSync.ts`'s doc comments): "renaming" a skill in
  the profile-mode draft (remove + add, since a resume draft's skills are plain strings) and syncing adds
  the new name alongside the old rather than replacing it — the old one needs manual removal on My
  Profile/Roles. Blanking an identity field (e.g. clearing Phone) and syncing does not clear it on the
  shared profile — an empty draft value always falls back to the existing value, per the "never
  destructively blank a shared field" rule.

**Files touched**: `types.ts` (`RoleDef.resumeMode`, `RoleDef.scratchResumeProfileId`), `storage.ts`
(mapping for both), new `lib/resumeSync.ts` (`diffResumeAgainstProfile`, `mergeResumeIntoProfile`, pure —
mirrors `lib/resumeCompose.ts`'s style), new `components/SyncResumeModal.tsx`; `ResumeBuilder.tsx`
(major rewrite — role tabs, three-mode switcher, the section-editor components at the bottom of the file
are unchanged and still reused by `ProfileTab.tsx`/`AddProfileItemModal.tsx`); `ResumeConfigTab.tsx`
(trimmed); `page.tsx` (new props into `<ResumeBuilder>` — shared `activeTemplateRole` state,
`onProfileChange`/`onUpdateRoleRules`, `userId`); both `supabase_setup.sql` copies (new section).

**Verified**: migration applied + verified live (two new columns on `role_defs`, correct default); clean
`frontend` build; lint shows only pre-existing idioms repeated across the file (not new — `catch (e:
any)`, the `useEffect(() => setMounted(true), [])` portal-mount pattern already used in
`AddProfileItemModal.tsx`/`resumePdf.tsx`, the sync-state-from-selected-id effect the original
`ResumeBuilder.tsx` already had); manual trace of `diffResumeAgainstProfile`/`mergeResumeIntoProfile`
against concrete cases (no changes → no prompt, new item → appended + selected, edited item → overwritten
in place, removed-from-draft item → never touched/reported, skill rename → additive not replacing,
identity edit → synced, identity blank → falls back rather than clearing) since there's no ts-node/tsx
runtime for direct-call testing of frontend TS, same standing limitation as `composeResumeData` itself;
dev server restart, clean 200s on `/resumes`, `/roles`, `/templates`, `/`. **Not verified**: no real
browser click-through of the three mode pills or the sync modal.

### Follow-up (2026-08-20) — "Additional files" removed; sidebar made collapsible
Two small, unrelated operator asks handled together.

**Additional files removed.** A role's send now attaches its resume only — the "extra files alongside the
resume" feature (`RoleDef.selectedFileIds`, its checklist UI in `ResumeBuilder.tsx`'s role view) is gone.
`lib/emailResolve.js`/`.ts`'s `resolveRoleAttachments` is simplified to `{resume, all}` where `all` is just
`[resume]` (or `[]`) — `resolveRoleAdditionalFiles` is deleted outright (fully superseded, same precedent
as the old `resolveRoleFiles` before it), and both workers' `role_defs` selects drop `selected_file_ids`
since nothing reads it anymore. No call-site changes needed beyond that: every consumer
(`automail.worker.js`, `batchSend.worker.js`, `QuickSendModal.tsx`) already only read `.all`. The
`selected_file_ids` column and `RoleDef.selectedFileIds` type field are **kept, just unread** — same
"superseded, never dropped" precedent as every other retired field in this project — so no migration was
needed and existing data isn't touched.

**Sidebar made collapsible.** New `sidebarCollapsed` state in `page.tsx`, persisted to `localStorage`
rather than Supabase (a display preference, not app data) — read once in a mount effect and corrected
client-side, same "default on server, correct in an effect" pattern `activeTab` already used for its own
SSR-safety reasons. A new `.sidebar-toggle` button sits between `<aside className="sidebar">` and
`<main className="main-content">` in the flex layout — a sibling, not a child of the sidebar — so it stays
visible and clickable regardless of collapse state. Collapsing shrinks `.sidebar`'s width to 0 (CSS
transition, `overflow: hidden`) rather than reducing it to an icon-only rail: the nav buttons
(`sidebar-tab`) have no icon set today, only two have an inline emoji (Recruiter/Admin), so a full
collapse was the lower-risk, no-new-icons choice.

**Files touched**: `lib/emailResolve.js`/`.ts` (simplified), `workers/automail.worker.js`/
`batchSend.worker.js` (selects trimmed, comments fixed), `ResumeBuilder.tsx` (additional-files block
removed), `ResumeConfigTab.tsx` (comment only), `types.ts` (`RoleDef.selectedFileIds` comment marks it
retired), `page.tsx` (`sidebarCollapsed` state + toggle button), `globals.css` (`.sidebar.collapsed`,
`.sidebar-toggle`); both `supabase_setup.sql` copies (retirement note on section 29, no schema change).

**Verified**: clean `frontend` build; backend `node --check` on every touched file; a direct-call test
against the real backend resolver confirming a role with `selected_file_ids` still set only ever attaches
its resume now; lint shows only pre-existing patterns well outside the touched lines (not new); dev server
restart, clean 200s on `/resumes`, `/roles`, `/templates`, `/`. **Not verified**: no real browser
click-through of the sidebar collapse toggle.

### Follow-up (2026-08-20) — Resumes tab's "Configuration" sub-tab renamed "Library"
Same-day follow-up to the Resume Builder redesign above. Operator's reasoning: once per-role resume
authoring (profile/scratch/upload) moved to Builder, Configuration only ever did one thing — hold the
candidate's file pool and let them pick a global default — so "Library" (the place resumes/files live,
where you also pick a default) names that better than "Configuration" ever did.

Pure rename + copy pass, no functional change: `page.tsx`'s `resumeSubTab` type literal
`"builder" | "configuration"` → `"builder" | "library"` (all five references — state declaration, button
text/condition/onClick, render condition). `ResumeConfigTab.tsx` keeps its file/component name (**rename
the label, not the file** — same precedent as `JobsRolesTab.tsx` staying `JobsRolesTab.tsx` while showing
"Roles" in the UI) but its panel headings were reframed: "Your Files" → "Your Resume Library", "Global
default resume" → "Your default resume" (copy now reads "pick which one from your library... is the
default").

**Also fixed while in the area**: several components still had hint text pointing candidates to "the
Resumes tab's Configuration sub-tab" for *per-role* resume management — stale since the Resume Builder
redesign (the entry above) already moved that to Builder; this was a documentation-sync oversight from
that pass, not something new. Corrected in `RoleTemplates.tsx`, `EmailConfigTab.tsx`, `ProfileTab.tsx`,
and `JobsRolesTab.tsx` — each now points to Builder (a role's resume) or Library (the file pool/default),
whichever is actually accurate for what that hint is about.

**Files touched**: `page.tsx` (type/state rename), `ResumeConfigTab.tsx` (headings/copy + doc comment),
`ResumeBuilder.tsx`/`RoleTemplates.tsx`/`EmailConfigTab.tsx`/`ProfileTab.tsx`/`JobsRolesTab.tsx` (hint
text and doc comments only — no props, state, or logic changed in any of them).

**Verified**: clean `frontend` build; lint shows only pre-existing patterns well outside the touched
lines (every change here is text/comment-only); dev server restart, clean 200s on `/resumes`, `/roles`,
`/templates`, `/`.

### Follow-up (2026-08-20) — Resume Builder/Library cleanup: real pagination, working bullets, naming
Same-day follow-up covering two real bugs found in the earlier Resume Builder redesign, plus several
requested simplifications. No schema change.

**Bug 1 — bullets could vanish in generated PDFs.** `lib/markdownLite.tsx` rendered bullet lines as a
native `<ul><li>`, relying on the browser's default disc marker. `html2canvas` — the library behind every
generated/emailed PDF attachment (`lib/resumePdf.tsx`) — is unreliable about painting native list markers,
so a bullet visible in the live DOM could be missing from the actual PDF. Fixed by rendering bullets as an
explicit `•` character in its own flex-row span, with no `list-style` involved anywhere — identical
rendering in the live preview, native print ("Download PDF"), and the html2canvas snapshot.

**Bug 2 — pagination was blind, in both the live preview and the generated PDF.** The live preview
(`ResumeBuilder.tsx`) rendered one endless scrolling div with no page boundaries. Separately,
`lib/resumePdf.tsx`'s `useResumeProfilePdf` sliced the flattened `html2canvas` image at *fixed pixel
offsets* (`heightLeft -= pageHeight`, blind to content) — it could cut an experience entry across a page
boundary even though the templates' `breakInside: "avoid"` styling implied that was handled (that CSS only
affects native browser print, which raster slicing never uses). New `lib/resumePaginate.ts`,
`computePageBreaks(containerEl): number[]` — measures every `[data-page-atom="true"]` element (a new
attribute added to the same wrapper divs that already had `breakInside: "avoid"` in
`ModernTemplate.tsx`/`ClassicTemplate.tsx` — one per experience/project/education/certification entry, one
on the single child of simple sections like Summary/Skills/Languages, one on the header — deliberately never
nested, so a flat `querySelectorAll` suffices) and returns Y-offsets where each page should end, always at
an atom's bottom edge. Shared by two consumers:
- `lib/resumePdf.tsx` — replaces the blind `heightLeft` loop; `jsPDF.addImage`'s per-page offset now comes
  from the real break list, converted from DOM px to PDF mm via the image/DOM height ratio.
- `ResumeBuilder.tsx`'s live preview — a `useLayoutEffect` + `ResizeObserver` re-measures on every content
  change and renders dashed page-boundary markers directly over the content (not a restructured DOM — an
  absolutely-positioned overlay, so the existing continuous-scroll layout is untouched), plus a
  "Page X of N ‹ ›" control that `scrollIntoView`s invisible anchors placed at each boundary — the "page
  clickers" the operator asked for, without building a full custom PDF-viewer.

A real transform bug was caught while implementing this (not anticipated in the plan): every measurement in
`computePageBreaks` goes through `getBoundingClientRect()` uniformly, including the page-height calculation
itself (derived from the container's own rendered width, not a separately-passed pixel number) — because
`offsetWidth`/`scrollHeight` ignore CSS transforms while `getBoundingClientRect()` reflects them, and the
live preview sits inside a `transform: scale(0.82)` ancestor (deliberately shrunk for on-screen display).
Mixing the two would have silently broken pagination only in the live preview, not in `resumePdf.tsx`'s
untransformed off-screen host — measuring everything the same way makes the function correct under any
transform, including none.

**Builder: "Upload your own" mode dropped.** Confirmed with the operator: uploading now only ever sets the
one candidate-wide default (chosen in the Library) — no more per-role upload override. `ResumeBuilder.tsx`'s
mode pills shrink to `["profile", "scratch"]`; the removed mode's JSX/handlers
(`handleRoleResumeChange`/`handleUploadRoleResume`/`roleFileUploading`) are gone.
`RoleDef.resumeMode`'s `"upload"` literal stays on the type/schema (never drop data), folded into the
"profile" pill for display via a new `effectiveMode()` helper — a role saved with that value from before
this change just shows the "profile" pill as active until the candidate clicks either pill, which
overwrites it. No resolver change: `lib/emailResolve.ts`/`.js`'s existing hierarchy (`resumeId` override →
candidate's `globalResumeId` → none) already gives the right fallback for a role that's never explicitly
saved a resume.

**Naming.** A new "Resume name" field sits on the "profile" mode toolbar — defaults to `` `${candidateName}
— ${roleLabel}` `` instead of a bare role label like "Automation," confirmed to matter because
`Attachment.name` is literally nodemailer's `filename` in both workers (recipients see whatever this field
says). Editable there, or via inline rename in the Library list (same field). **"Just this resume" now
prompts for a name** (confirmed with operator): `SyncResumeModal.tsx` reveals a name input under that
choice (default `` `${roleLabel} (edited copy)` ``) instead of finalizing immediately. The result is a
**new, separately named Library entry that does not replace the role's active resume** —
`finalizeProfileResumeSave` gained a `keepAsDefault: boolean` param: `true` (Save with no changes, or "Save
to Profile & Role") regenerates/replaces the role's resume in place as before; `false` ("Just this resume")
always appends a new `Attachment` and never touches `RoleDef.resumeId`.

**Library simplified** (`ResumeConfigTab.tsx`) — per operator ask ("that's it, simple"): removed the
"Generate from Resume Builder…" dropdown (a resume you build now always goes through Builder's own
Save/"Use as resume" flow, which already lands it here — a second parallel path to the same result was the
confusion) and the "🔄 Regenerate" button ("I don't know what the 'degeneration' button means"). Every list
row is now the resume itself: inline-editable name (click to rename, same field Builder's "Resume name"
writes to), and a radio marking the one candidate-wide default — replacing the standalone "Your default
resume" card entirely. `useResumeProfilePdf` is no longer used in this component at all (nothing left here
generates a PDF). The `resumeProfiles` prop is dropped from both the component and its `page.tsx` call site
— nothing in this trimmed-down component reads it anymore.

**Import from a resume** kept (not removed, per operator: "the import from resume feature is also fine")
but given a real second entry point: the scratch mode's empty state now offers "+ Start a resume" and
"✨ Import from an existing resume" as two equally-weighted options, instead of import being a small
toolbar button only visible once a blank draft already exists. A new `handleImportFromEmptyState` creates
the scratch `ResumeProfile` seeded directly with the imported fields in one step (rather than create-then-
merge, which would race the prop round-trip deciding when the component's own `scratchProfile` reflects the
new row).

**Files touched**: `lib/markdownLite.tsx` (bullet fix), new `lib/resumePaginate.ts`, `lib/resumePdf.tsx`
(content-aware slicing), `lib/resumeTemplates/ModernTemplate.tsx`/`ClassicTemplate.tsx`
(`data-page-atom` attributes, no visual change), `ResumeBuilder.tsx` (mode pills, naming, paginated preview,
rewired save flow), `SyncResumeModal.tsx` (name-input reveal), `ResumeConfigTab.tsx` (simplified list),
`page.tsx` (drop the now-unused `resumeProfiles` prop from `<ResumeConfigTab>`).

**Verified**: clean `frontend` build (first try); lint clean of new issue classes (only pre-existing idioms
— `catch (e: any)`, the mount-effect pattern, page.tsx's unrelated pre-existing warnings); manual trace of
`computePageBreaks` against synthetic multi-entry cases (normal multi-page split lands on atom boundaries
— confirmed no entry straddles a page break; a single atom taller than one page forces a best-effort break,
the only case where a mid-atom cut is unavoidable; an atomless/empty resume falls back to the old blind
slicing rather than producing no pagination at all); dev server restart, clean 200s on `/resumes`,
`/roles`, `/templates`, `/`. **Not verified**: no real browser click-through of the paginated preview,
rename, or default-radio controls; no live PDF/email round-trip to visually confirm the bullet/pagination
fixes against a real generated attachment (no Gemini key or SMTP send exercised this session either way).

### Follow-up (2026-08-20) — crash fix, zero-click default, always-append saves, unique names (second
same-day follow-up)
The previous follow-up's "verified" section above was build/lint/manual-trace only — **it had never
actually been opened in a browser**, and Builder crashed on open. This pass used Playwright to drive a real
browser against the running dev server, which is how the crash (and two more real bugs) surfaced.

**Crash: "Maximum update depth exceeded," Builder unusable the instant it opened in the default view.**
`ResumeBuilder.tsx`'s `profileDraft` (line ~102 at the time) computed
`profileDrafts[active.id] ?? composeResumeData(candidateProfile, active)` inline in the render body as a
fallback — until the candidate's first edit seeded `profileDrafts`, this called `composeResumeData` fresh
every render, a brand-new object each time. That object fed `formData`, which the pagination
`useLayoutEffect` (added in the previous follow-up) depends on: every render re-triggered the effect, which
called `setPageBreaks`/`setCurrentPage`, which re-rendered, which recomputed `profileDraft` as a new object
again — an infinite loop, synchronous within React's layout-effect flush, tripping React's 25-nested-update
safety limit. Fixed by wrapping the computation in `useMemo(() => ..., [active, profileDrafts,
candidateProfile])`, giving it a stable reference across re-renders whenever its actual inputs haven't
changed. Also added a defensive equality guard inside `measure()` itself (skip `setPageBreaks` when the new
array is shallow-equal to the current one) as insurance against the same class of bug recurring elsewhere —
`computePageBreaks` always returns a new array reference even when the content is identical.

**Bug: bullets still rendered as a literal "-" against real content.** The previous follow-up's fix
(explicit "•" glyph instead of native `<ul><li>`) was correct but insufficient — `lib/markdownLite.tsx`'s
bullet regex was `/^[-*]\s+(.*)$/`, requiring at least one space after the marker. Real content, especially
AI-imported resume text (confirmed by reading the actual `textarea.value` via Playwright — the accessibility
snapshot flattens whitespace and had been hiding this), often has no space at all: `"-Spearheading growth
strategies…"` not `"- Spearheading…"`. Every such line fell through as an unrecognized plain paragraph,
dash included. Relaxed to `/^[-*]\s*(.+)$/` (zero-or-more spaces; `.+` instead of `.*` so a bare "-" with
nothing after it still isn't treated as an empty bullet).

**Bug: `Attachment.name` was silently slug-sanitized, undermining the whole naming feature.**
`lib/resumePdf.tsx`'s `useResumeProfilePdf` derived the `File`'s name via
`` `${(profile.label || "resume").replace(/[^a-z0-9]+/gi, "-")}.pdf` `` — this turned "Muhammad Sohaib Amin
— AI Automation" into "muhammad-sohaib-amin-ai-automation.pdf" everywhere it's displayed (Library list) and
emailed (`Attachment.name` === nodemailer's `filename`). Discovered via a live save-and-inspect test.
Pointless mangling: `lib/storage.ts`'s `uploadAttachment` already writes to a fully randomized storage path
(`${Math.random()...}_${Date.now()}.${ext}`) and never reads `file.name` for anything storage-related — the
only thing `file.name` feeds is the returned `Attachment.name`. Fixed to only strip characters that would
actually be unsafe in a filename (`\ / : * ? " < > |`) and avoid double-appending ".pdf" if the label
already ends with it, preserving spaces/em-dashes/punctuation otherwise.

**Zero-click default resume** (operator ask, 2026-08-20: "the default resume generative[d from] profile
should always be in our library but we do not have to manually save it"). New `useEffect` in
`ResumeBuilder.tsx`: the moment a role is opened in "profile" mode and `lib/emailResolve.ts`'s
`resolveRoleResume(active, candidateProfile)` returns null (no override of its own, no candidate-wide
`globalResumeId` fallback either — genuinely nothing would resolve for a send), it silently
compose-and-saves one right away, identical to what clicking Save with zero edits does. Two trigger options
were weighed with the operator — "the moment I open that role in Builder" (chosen) vs. "the moment I save my
Profile" (would cover roles never opened in Builder too, at the cost of background PDF generation on every
profile save) — chosen because PDF generation only happens in-browser (`html2canvas`), so the background
send worker can never do this regardless; a role never opened in Builder still has nothing until it is, same
as before this change. `attemptedAutoDefaultRoles` (a `useRef<Set>`) guards against retrying every render;
a failed attempt is removed from the set so the next visit can retry.

**Saves never silently overwrite the Library anymore** (operator ask: "then it will create another
instance, the resume in the library will stay as it is"). `finalizeProfileResumeSave` gained an
`alwaysNewInstance` param, decoupled from the existing `keepAsDefault` (which still controls whether the
role's `resumeId` points at the result): `true` for the "Save to Profile & Role" sync path — real edits were
made, so the previous entry stays exactly as it was, a brand-new `Attachment` is appended instead, and the
role's `resumeId` moves to point at it — and for "Just this resume" (unchanged behavior, already
append-only). `false` (the default) only applies to "no edits, just re-click Save," which still regenerates
the same entry in place — there's nothing new to preserve as a separate version, and self-collision (saving
under the same name it already has) is excluded from the uniqueness check below.

**Names must be unique across the whole Library, and a collision blocks rather than silently renaming**
(operator ask, confirmed over an auto-suffix alternative: "it's better not to have the same names... block
and ask me to rename," so nothing — a human choosing what to send, or the background worker resolving one
automatically — can ever grab the wrong resume by name collision). New `lib/resumeNaming.ts`:
`isNameTaken(name, files, excludeId?)` (case-insensitive, trimmed) is the shared guard used everywhere a
name gets set — `ResumeBuilder.tsx`'s Save (excludes the entry being replaced in place), Sync modal's both
choices (no exclusion — always a new instance), "Use as scratch resume", and `ResumeConfigTab.tsx`'s upload
+ inline rename — all show an inline error (`nameError` state) and refuse to proceed rather than applying
anyway. `uniqueNameFallback` (silent auto-suffix) is the one deliberate exception, used only by the
zero-click auto-default path above, since there's no UI moment to ask at when it runs.
`SyncResumeModal.tsx` was restructured: "Save to Profile & Role" reuses Builder's current "Resume name"
field with no extra step in the common (non-colliding) case, but now reveals the same kind of name-input
step "Just this resume" already had if that name turns out to be taken.

**Files touched**: `lib/markdownLite.tsx` (regex fix), `lib/resumePdf.tsx` (filename-sanitization fix), new
`lib/resumeNaming.ts`, `ResumeBuilder.tsx` (memoized `profileDraft`, pagination guard, auto-default effect,
`alwaysNewInstance`, name-collision checks), `SyncResumeModal.tsx` (naming step for both choices),
`ResumeConfigTab.tsx` (upload/rename collision guard).

**Verified live in a real browser this time** (Playwright driving the actual running dev server, not just
build/lint/manual-trace): Builder opens with zero console errors in profile mode (the crash is gone);
bullets render as "•" against real AI-imported content that has no space after the dash; typing a name that
collides with an existing Library entry shows the inline error and is genuinely blocked (no toast fires, no
new file appears); a non-colliding save produces exactly the typed name in the Library, spaces and
em-dashes intact (confirmed via reading `Attachment.name`, not just the accessibility tree, which flattens
whitespace and had masked the bullet bug earlier in this same investigation). Clean `tsc --noEmit`, clean
`npm run build`, `npx eslint` on every touched file shows only pre-existing idioms. **Not verified**: the
zero-click auto-default path specifically — the operator's real test account already had a working
candidate-wide default resume, so `resolveRoleResume` never actually returned null during testing, and
clearing the operator's real default just to force that path felt like the wrong tradeoff against a
type-checked, logic-reviewed implementation. Also not verified: the pre-existing pagination guard-rail
requested in the same message ("if the section is being cut through from the half, move that whole section
to the next page, but it's not always the case") — already satisfied by the previous follow-up's
`computePageBreaks`, confirmed by re-reading the implementation rather than by a fresh test, since nothing
about it changed this pass.

### Follow-up (2026-08-20) — fixed one-page viewport, scroll-synced pages, typography controls (third
same-day follow-up)
Full plan (Context/decisions/verification) preserved at the time of writing in
`C:\Users\msamr\.claude\plans\woolly-discovering-candle.md`. Three connected requests, handled together
since they share one root cause and one layout mechanism.

**Root cause of "pages not breaking apart," found and fixed at the source.** Not the previous follow-up's
bug (that fixed the bullet *renderer*) — this is a real defect in `computePageBreaks` itself, found by
reasoning through the CSS and then confirmed with an empirical browser repro (via a Plan subagent, before
any code was written) rather than assumed. The function measures every atom's position via
`getBoundingClientRect()`, deliberately, so it reflects whatever transform/zoom is active on an ancestor at
measurement time (the live preview sits inside a scale transform). Those measured values used to be
returned *as-is* — fine for page *count* (scale-invariant, pure ratios within one constant factor) but wrong
the instant a caller reapplies a returned value as a literal `top`/`transform: translateY()` on an element
*inside that same transformed subtree*: `top`/`translateY` are always interpreted in an element's own
**local** (pre-ancestor-transform) space, so an already-visually-shrunk value gets shrunk a second time at
paint time. Confirmed via repro: a native 500px offset, measured through a `scale(0.82)` ancestor as 410px,
reapplied as `top: 410px` in that same scaled subtree, rendered at 336px on screen — a real, constant ~18%
compounding error, worse on later pages. This is why the dashed page markers never lined up correctly and
pages looked compressed/broken, independent of the sidebar.

The first proposed fix — swap the fixed `transform: scale()` for CSS `zoom`, reasoning that zoom
"genuinely" resizes the coordinate system so this disconnect wouldn't apply — was **tested and disproven**
by the same repro (`zoom: 0.82` produced the identical -73.8px mismatch). The actual fix: make
`lib/resumePaginate.ts`'s `computePageBreaks` self-correcting. It computes
`const scale = containerRect.width / containerEl.offsetWidth || 1` (`offsetWidth` ignores transform *and*
zoom identically — also confirmed empirically) and divides every returned atom-bottom and the total height
by that factor before returning, so the function now always returns **native-space** px regardless of what's
active on the ancestor chain — genuinely delivering what its header comment already claimed but previously
didn't (it got page *count* right, never the raw values). `lib/resumePdf.tsx`'s off-screen host has no
transform/zoom at all, so `scale` there is always 1 — a confirmed no-op for the already-correct
PDF-generation path.

**Layout rebuilt to the operator's literal spec**: "the resume page should always be visible in front of
me... one page should be visible at a time... I should be only able to scroll the content on the left
side... [scrolling] it will automatically shift to the next page." This wasn't a UX polish pass — the old
design (one long scrolling image with dashed dividers, a `position: sticky` preview column, `flexWrap:
"wrap"` letting the two columns stack on narrow width) is gone, replaced with:
- A real "page window": `.resume-print-area` is now a fixed, real-world-sized (`210mm × 297mm`)
  `overflow: hidden` box. The full, all-pages-concatenated rendered content (still the single DOM tree
  `computePageBreaks` measures) sits inside it on a child (`.resume-print-content`, `previewContentRef`)
  that shifts via `transform: translateY(-startPx)` to reveal only the current page — `startPx` comes
  directly from the now-native-space `pageBreaks` array, safe to reuse as-is.
- A `ResizeObserver` on the available space (`previewViewportRef`) computes `fitScale = min(availW/
  nativeW, availH/nativeH, 1)` (native size read once via `offsetWidth`/`offsetHeight`, which are constant
  regardless of the fixed mm-based CSS size), applied via CSS `zoom` on `.resume-print-area` — `zoom`, not
  `transform`, specifically because it shrinks the element's own reserved *layout* footprint along with its
  visual size, so the flex box around it sizes correctly with zero extra placeholder-box bookkeeping (this
  is a different, valid use of zoom than the rejected marker-position fix above — it doesn't touch page-
  break values at all, it only affects the outer fit-to-viewport step, and works correctly *because*
  `computePageBreaks`'s fix makes its output safe to reapply under any active scale mechanism).
- A pure-CSS flexbox height chain gives the editor column a bounded box to scroll within and the preview
  column a bounded box to fit into, instead of `.main-content` scrolling the whole builder view as one
  piece (previously, a nested `max-height`/overflow box directly on the editor column had been tried and
  reverted for exactly this reason in an earlier pass — the difference this time is bounding the *ancestor
  chain's height* via flex, not fighting `.main-content`'s own scroll with a second nested one). The chain,
  verified against the actual DOM (a real, easy-to-miss link found along the way: `page.tsx`'s
  `<div className="board">` sits between `.main-content` and the Resumes-tab content and is `display:block`
  by default, shared by every tab — a naive `height:100%` on a descendant wouldn't have resolved against it
  silently, so it's now conditionally `height:100%; display:flex; flexDirection:column; minHeight:0` only
  when `activeTab === 'resumes'`): `.board` (conditional) → the Resumes-tab wrapper div → `ResumeBuilder`'s
  root → the two-pane row, `flex:"1 1 auto"; minHeight:0` at every link, `flexWrap` changed `"wrap"` →
  `"nowrap"` on the row itself (removing the width-triggered stacking that was compounding the sidebar-
  collapse complaint — nothing about `.resume-print-area`'s own size actually depends on sidebar state,
  since it's a fixed mm value; it was the *columns wrapping* under a narrower row, on top of the always-
  present transform bug above, that made collapse look like it was actively breaking something).
- **The chain's outermost link isn't in this component at all (2026-08-24, bug fix).** `.app-container`
  (`page.tsx`) is a fixed `height:100vh; overflow:hidden` shell by design — only its own internal panes
  (`.main-content`, and inside Resumes, the editor column above) are meant to scroll. But `layout.tsx`'s
  global `<footer>` is a permanent sibling of `{children}` in `<body class="flex flex-col min-h-screen">`
  on *every* route, app shell included — its height stacked on top of `.app-container`'s own 100vh pushed
  body's total content past the viewport, and with nothing setting `overflow-y:hidden` on html/body, the
  *whole document* became scrollable on top of the intended internal scrolling. Symptom: scrolling anywhere
  outside the two intentional panes scrolled the entire shell instead of doing nothing. Fixed with one scoped
  rule in `globals.css` — `body:has(.app-container) footer { display: none; }` — rather than touching
  html/body globally, so marketing pages (`/login` etc., no `.app-container`) keep their normal footer.

**Scroll-linked page auto-sync.** Editor-side blocks get `data-atom-key`, mirroring the same stable keys
(`.id` for repeatable entries, a fixed string for the single-block sections) the preview templates' atoms
already carry: each Experience/Project/Education/Certification entry's own wrapper div directly, and a new
optional `atomKey` prop on the shared `FormSection` wrapper for PersonalInfo ("header")/Summary/Skills/
Languages, which render one atom for the whole section rather than one per row (Languages in particular —
its preview atom is one paragraph joining every language, not one atom per row, so its editor-side key also
lives on the whole `FormSection`, not per-entry, mirroring that). `computePageBreaks` gained a second return
value, `atomPage: Record<string, number>` — which page each key landed on, computed in the same measurement
pass the `breaks` array already comes from. The editor column's own scroll handler (rAF-throttled plain
scroll-position polling — chosen over `IntersectionObserver` because an observer only reports unordered
"near-visible" booleans, still needing a `getBoundingClientRect()` ranking pass afterward, so a direct
handler does the identical job in one pass with no `rootMargin` tuning, and the atom count here is small and
bounded either way) finds the last `[data-atom-key]` element at or above roughly 28% down the editor's own
viewport and switches `currentPage` to whatever `atomPage` says that key's content lands on. Manual prev/
next (`goToPage`) just calls `setCurrentPage` directly — no "pinned" mode; the next scroll event naturally
re-syncs afterward, matching "I should be able to do it manually but by scrolling it should automatically
shift."

**Typography controls** (operator ask: "I should be able to control the text size and the font... the
padding of the page, the distance between the lines, the distance between the characters"). New
`ResumeStyleSettings` type + `defaultResumeStyle()` in `lib/types.ts`; `style?: ResumeStyleSettings` added to
`ResumeData` itself (optional, so already-persisted rows predate it safely) — living there, like `summary`
or `skills`, means it threads through `profileDraft`/`scratchDraft`/`ResumeProfile.data` and into
`resumePdf.tsx`'s PDF generation automatically, no new persistence plumbing or prop threading anywhere.
`ModernTemplate.tsx`/`ClassicTemplate.tsx` both read `data.style ?? defaultResumeStyle()`: font-family and
line-height apply once at the root (inherited); every one of the ~12 per-template hardcoded `Npt` sizes
converts to an em multiple of the root's own font-size (`${N/10.5}em`, 10.5 being each template's previous
hardcoded base) so the whole document scales proportionally, not just body text — safe to convert
mechanically since every one of those sites sets its own font-size directly rather than relying on inherited
em-sizing from another converted element (verified no nesting risk in either template). Letter-spacing is
the one subtlety: each template's `h1` and `Section`'s `h2` already hardcode their own tracking as a
deliberate design choice (tight for the name, wide for section labels) — a literal inline `letterSpacing`
there would *override* rather than *add to* the root's inherited value, silently discarding the operator's
control on headings, so both compose the setting via a `--rf-tracking` CSS custom property instead. Page
padding is the one setting living outside the templates (it's `.resume-print-area`'s own CSS padding, not
template-owned) — moved to an inline style read from `formData.style.pagePaddingMm` in `ResumeBuilder.tsx`,
and mirrored in `resumePdf.tsx`'s off-screen host (which, incidentally, had *no* padding at all before this
pass — a real, previously-unnoticed parity gap between the live preview and the actual generated PDF, now
closed). A new `StyleSection` (font-family `<select>` of 6 safe system-font stacks + four range sliders with
numeric readouts) sits in the editor column, wired via the same `formOnChange` pattern every other section
uses.

**Print path needed three new resets, not the pre-existing one.** `handleDownload()`'s `window.print()` is a
*third*, separate rendering path (`globals.css`'s `@media print`, governed by neither the live preview's
React state nor `resumePdf.tsx`) — it previously only reset the old fixed `transform: scale(0.82)`. Now
resets: `.resume-print-area`'s `zoom: 1 !important` (the new fit-scale mechanism) plus
`overflow: visible !important; height: auto !important` (undoing the fixed one-page window, so the browser's
native pagination sees the full content and can paginate across as many pages as needed, same reasoning this
block already documented for width); and a new `.resume-print-content` class on `previewContentRef` reset to
`transform: none !important` (undoing the on-screen page-reveal translateY, or the printed output would be
vertically offset by whichever page happened to be selected on screen). All three confirmed via Playwright's
print-media emulation, not just code review.

**Files touched**: `lib/resumePaginate.ts` (self-correcting scale, `atomPage`), `lib/types.ts`
(`ResumeStyleSettings`/`defaultResumeStyle`/`RESUME_FONT_OPTIONS`), `lib/resumeTemplates/ModernTemplate.tsx`/
`ClassicTemplate.tsx` (style-driven typography, `data-atom-key`), `lib/resumePdf.tsx` (padding parity,
updated `computePageBreaks` destructuring), `app/globals.css` (print resets, `.resume-print-area` simplified
to chrome-only), `app/[[...tab]]/page.tsx` (height chain), `components/ResumeBuilder.tsx` (the bulk of the
work — page window, `fitScale`, scroll-sync, `StyleSection`, `FormSection`'s `atomKey` prop, `data-atom-key`
on every entry).

**Verified live** (Playwright driving the actual running dev server throughout, not build/lint alone, given
this exact class of gap caused a shipped crash the previous same-day pass): the preview shows exactly one
full page, confirmed never scrolling itself; scroll-sync confirmed working (scrolling the editor 60% of the
way down jumped the preview from page 1 to page 4 of 5, matching where that content actually landed); manual
prev/next confirmed moving pages cleanly in both directions; all four typography controls confirmed changing
the live preview (font family swap, text-size slider confirmed via computed `font-size` going from 14px to
the expected 17.33px at the slider's max, letter-spacing confirmed via computed `letter-spacing` going from
`normal` to `1.12px`, page padding confirmed via computed `padding` going from 56.7px to 30.2px — exactly
15mm→8mm at 96dpi both times) — and pagination correctly recomputed (5→8 pages) when the changed typography
pushed more content per page; sidebar collapse/expand confirmed correctly rescaling the preview (the
rendered width changed appropriately with available space at a viewport size where width was the binding
constraint, and correctly did *not* change at a size where height was already binding — both are the
mathematically correct outcome, not a bug); Save (the real `resumePdf.tsx` PDF-generation path, not just the
live preview) confirmed still producing a correctly-named Library attachment with zero console errors
throughout; the three print-media resets confirmed via Playwright's print-media emulation. Clean
`tsc --noEmit`, clean `npm run build`, `npx eslint` on every touched file shows only pre-existing idioms.

### Follow-up (2026-08-20) — preview too small + page breaks still wrong (fourth same-day follow-up)
Reported right after the third follow-up shipped. No plan file this time — both bugs were found by live DOM
measurement mid-investigation (Playwright `getBoundingClientRect()` reads, not screenshots — screenshots at
this zoom level were genuinely ambiguous and misled the first read of the page-2 boundary), not knowable
upfront from the code alone.

**"Too small"**: `computePageBreaks`'s `pageHeightPx` was `containerRect.width * A4_ASPECT / scale` —
`containerEl` is `previewContentRef`, which deliberately excludes the page's own padding (it's a plain
content div; padding lives on an ancestor), so this ran the *inner* content width through the *outer* page's
aspect ratio, and never subtracted padding from the result at all. Both mistakes make the computed
per-page capacity too small, so pages fill up early — this resume was landing on 6 pages instead of the ~5 it
actually needs. Fixed by reconstructing the true outer width (`containerEl.offsetWidth + 2*paddingPx`) before
applying the aspect ratio, then subtracting `2*paddingPx` from the result. `computePageBreaks` now takes an
explicit `paddingPx` param (both callers convert their `pagePaddingMm` via a new `mmToPx()` export) — see the
function's own header comment for the full reasoning. Separately (not a bug, a real space reclaim): the
per-resume header content (hint paragraph, "Resume name" field, scratch-mode's toolbar) used to sit as fixed
chrome *above* the two-pane split, so both the editor *and* the preview columns paid for its height even
though only the editor needs it. `renderFormAndPreview` gained a `header` param and that content now renders
as the first thing inside the scrollable editor column instead — visually identical at rest (scroll position
0), but it scrolls away instead of permanently taxing the preview's height budget. Confirmed live: the
preview's available height went from 558px to 659px (+18%) at a fixed 900px test-viewport height; the gain is
proportionally larger at realistic 1080px+ viewport heights (confirmed via a second live check).

**"Page break also not right" — a real content-duplication bug, not cosmetic.** Found by measuring exact DOM
positions after a screenshot read had been misleading: `.resume-print-area` carried the page's padding *on
the same element* that also did the `overflow: hidden` clipping and the `translateY` page-sliding. CSS
padding doesn't clip an overflowing sibling — it only reserves space for content that fits inside it — so
whenever the sliding content's *previous*-page tail fell within the last `paddingMm` of that page, it kept
rendering (and visibly repainting) into what was supposed to be the next page's blank top margin. Confirmed
directly: the last two bullets of one experience entry were duplicated, visible both at the true bottom of
page 1 and again at the top of page 2. Fixed by moving padding out of the clipped/sliding element entirely —
top and bottom now live in two fixed-height spacer `<div>`s that sit *outside* the clipping boundary (new
`.resume-print-clip` div, sandwiched between the spacers, carries only left/right padding plus the
`overflow: hidden` and holds `previewContentRef`), so nothing can ever render into them regardless of scroll
position. A second, subtler instance of the exact same root cause turned up immediately after fixing the
first: the clip window's height was a *constant* full page height, but `computePageBreaks` can legitimately
end a page short of that (the next atom didn't fit in the remainder — happened here: Paytonika's entry ended
at 833px into the content flow, but the *next* entry needed 276px and only 176px of the 1009px page budget
was left) — the constant-height clip then showed the unclaimed leftover space of the *next* page's content
early, which duplicated with what page 2 also showed once it slid to that same starting point. Fixed by
sizing the clip to `pageBreaks[currentPage] - pageBreaks[currentPage-1]` — this page's actual content span —
every render, not a constant. Verified by stepping through all 5 pages individually (separate tool calls, not
a batched async loop — an earlier batched attempt produced misleading off-by-one results from a render-timing
race) and checking each page's exact first/last visible line: no duplication, no gaps, every page a clean
atom-boundary continuation of the previous one's last line.

**`lib/resumePdf.tsx`'s actual PDF-generation path needed the equivalent fixes**, since it's structurally
independent of the live preview (a separate off-screen `html2canvas`+`jsPDF` render). Gained its own unpadded
`contentRef` nested inside the existing padded `hostRef` (mirroring the live preview's spacer/clip split) so
`computePageBreaks` gets the same padding-aware math there too. The "next page peeking through" issue has no
direct equivalent fix in jsPDF (`addImage` has no per-draw clip rect), so it's masked with a plain white
`pdf.rect(x, y, w, h, "F")` covering any page's unused tail — visually identical to a true clip since the
resume's captured background is already solid white. Verified with a real, controlled Save (not just
reasoning about the math): a temporarily-named test entry was generated end-to-end with zero console errors,
confirmed present in the Library, then deleted immediately after to restore the operator's real account to
its clean prior state (same real-account-data caution as every previous pass this session).

**Files touched**: `lib/resumePaginate.ts` (padding-aware `pageHeightPx`, new `mmToPx()` export),
`components/ResumeBuilder.tsx` (`renderFormAndPreview`'s new `header` param, the spacer/clip/page-slice DOM
restructure, `thisPageContentPx`), `lib/resumePdf.tsx` (`contentRef`, white-rectangle page-tail mask),
`app/globals.css` (two new print resets: `.resume-print-clip`, `.resume-print-page-slice`),
`app/[[...tab]]/page.tsx` (tightened the Resumes-tab header/tab-row margins as part of the space reclaim).

**Verified live**: zero console errors through every step; page count corrected (6→5); all 5 pages stepped
through individually confirming clean, non-duplicated, non-gapped atom-boundary transitions; preview sizing
confirmed larger at both a 900px and a 1080px test-viewport height; a real Save through the actual PDF
pipeline confirmed working end-to-end, test artifact cleaned up afterward. Clean `tsc --noEmit`; lint clean of
new issues (only the same pre-existing idioms noted in every previous pass).

## Resume source labels + per-category uniqueness (2026-08-25)
Operator ask: tell resumes apart by where they came from, and stop silent name collisions within a
category. `frontend/src/lib/resumeNaming.ts` gained `resumeSource(file): "upload" | "scratch" | "profile"`
(checked via `Attachment.sourceResumeProfileId`/`sourceRoleId` — no new field needed, the source was already
derivable) and `RESUME_SOURCE_LABELS`; `ResumeSourceBadge.tsx` (new) renders the label as a small pill on
`ResumeConfigTab`'s Library rows. `isNameTaken`/`uniqueNameFallback` (pre-existing, from the 2026-08-20
Resume Builder redesign) gained a `source` parameter — uniqueness is enforced **per category**, not
globally, so "Resume" can exist once as an upload and once as a from-scratch build without colliding.

## Schema file (fixed 2026-08-17)
`frontend/database/supabase_setup.sql` and `backend/database/supabase_setup.sql` used to be two independently
drifted copies (missing columns the code actually depends on, plus text corruption in one). Both were rewritten
2026-08-17 into one consolidated, idempotent script — mirrored byte-identical in both locations — and applied
to a fresh Supabase project. There's still no migration *tool*; keep doing schema changes as `add column if not
exists` appended to that script, applied via the Supabase Management API (`SUPABASE_ACCESS_TOKEN` +
`SUPABASE_PROJECT_REF` in `backend/.env`) or the SQL editor, and re-copy the file to the other location.

Two real bugs surfaced while reconciling the schema against the code (see `docs/memory.md` for status):
1. **Fixed** — the attachments storage bucket was created as `attachments`, but `frontend/src/lib/storage.ts`
   uploads to `automailsend_attachments`. The schema script now creates the bucket under the name the code
   actually uses.
2. **Fixed 2026-08-17** — `backend/src/workers/batchSend.worker.js` read `automailsend_app_state.delay_sec`
   for the manual-batch send delay while everything else read/wrote `send_delay_sec`; fixed to match during
   the multi-SMTP rewrite (both columns still exist in the schema, `delay_sec` is now simply unused).
