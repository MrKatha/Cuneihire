-- Supabase Setup Script for AutoMailSend / Viddr
--
-- Rewritten 2026-08-17 as a single authoritative version, consolidated from what the running
-- frontend + backend code actually reads and writes (both prior copies of this file — here and in
-- frontend/database/ — had drifted badly out of sync with reality and with each other; this replaces
-- both). Idempotent throughout (`if not exists` / `create or replace`), safe to re-run.
--
-- Fixes two real bugs found while reconciling this against the code:
--   1. The attachments storage bucket was created as "attachments", but frontend/src/lib/storage.ts
--      actually uploads to a bucket named "automailsend_attachments" — the bucket name below matches
--      the code.
--   2. automailsend_sent_log had no created_at column, but the admin "view user" API
--      (frontend/src/app/api/admin/users/[userId]/route.ts) orders sent_logs by created_at — added.
--
-- Known separately (not fixed here, needs its own decision): backend/src/workers/batchSend.worker.js
-- reads `delay_sec` for the manual-batch send delay, while automail.worker.js and the frontend
-- (storage.ts) all use `send_delay_sec`. Both columns exist below so neither code path errors, but the
-- manual batch-send delay is effectively reading a column the UI never writes to. Flagged in
-- docs/memory.md for a follow-up fix.

-- 1. Attachments storage bucket (name must match frontend/src/lib/storage.ts's `.storage.from(...)` calls)
insert into storage.buckets (id, name, public)
values ('automailsend_attachments', 'automailsend_attachments', true)
on conflict (id) do nothing;

create policy "automailsend_attachments: authenticated upload"
on storage.objects for insert
to authenticated
with check ( bucket_id = 'automailsend_attachments' );

create policy "automailsend_attachments: public read"
on storage.objects for select
to public
using ( bucket_id = 'automailsend_attachments' );

create policy "automailsend_attachments: owner delete"
on storage.objects for delete
to authenticated
using ( bucket_id = 'automailsend_attachments' and (auth.uid() = owner) );

-- 2. automailsend_app_state — one row per user; SMTP config, AI/Automail settings, auto-fetch config,
--    admin-controlled entitlements
create table if not exists public.automailsend_app_state (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null unique,

  -- SMTP
  config jsonb default '{"email": "", "appPassword": "", "configured": false}'::jsonb,
  smtp_email text default '',
  smtp_password text default '',
  send_delay_sec integer default 3,
  delay_sec integer default 3, -- see note above re: batchSend.worker.js vs the rest of the app

  active_template_role text default 'fullstack',
  default_title text default '',

  -- Manual batch send
  batch_send_pending boolean default false,
  batch_send_processing boolean default false,

  -- LinkedIn auto-fetch (scraper)
  auto_fetch_enabled boolean default false,
  auto_fetch_keywords text default '',
  auto_fetch_template_role text default 'fullstack',
  auto_fetch_interval_min integer default 5,
  auto_fetch_pagination_limit integer default 3,
  auto_fetch_pagination_delay_sec integer default 10,
  auto_fetch_raw_headers text default '{}',
  post_age_filter text default 'any',
  cookie_li_at text default '',
  cookie_jsessionid text default '',

  -- Automail (background sending) + AI personalization
  automail_enabled boolean default false,
  daily_mail_limit integer default 50,
  ai_provider text default 'none', -- superseded 2026-08-18, left in place unused — see ai_personalization_enabled below
  ai_api_key text default '', -- superseded 2026-08-18, left in place unused — platform now uses its own Gemini key
  candidate_info text default '', -- who the user is; combined with the hardcoded prompt in ai.service.js

  -- Admin-controlled (set via /api/admin/users, never by the user themselves)
  is_blocked boolean default false,
  allowed_products jsonb default '[]'::jsonb,

  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now())
);

-- 3. automailsend_recipients — scraped or manually-added contacts
create table if not exists public.automailsend_recipients (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  email text not null default '',
  phone text default '',
  role text not null,
  title text default '',
  status text default 'pending', -- pending | sent | failed
  phone_status text default 'pending', -- pending | sent | wrong_number
  source text default 'manual', -- manual | auto_fetch
  source_url text,
  context_text text,
  scraped_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

-- 4. automailsend_templates — per-role email template
create table if not exists public.automailsend_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  role text not null,
  subject text default '',
  content text default '',
  files jsonb default '[]'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now()),
  unique(user_id, role)
);

-- 5. automailsend_sent_log — history of every send attempt (sent/failed/skipped)
create table if not exists public.automailsend_sent_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  email text not null,
  role text not null,
  title text default '',
  subject text,
  body text,
  status text default 'sent', -- sent | failed | skipped
  error_message text,
  sent_at timestamp with time zone default timezone('utc'::text, now()),
  created_at timestamp with time zone default timezone('utc'::text, now())
);

-- 6. automailsend_execution_logs — one row per worker run (scraper / automail / batchSend), live-updated
create table if not exists public.automailsend_execution_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  status text not null, -- running | success | error | failed
  message text not null,
  details jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now())
);

-- 7. automailsend_global_settings — single-row (id=1) operator-controlled config, read publicly
create table if not exists public.automailsend_global_settings (
  id smallint primary key default 1,
  min_fetch_interval integer default 5,
  min_pagination_delay integer default 5,
  max_pagination_limit integer default 10,
  allow_signups boolean default true,
  updated_at timestamp with time zone default timezone('utc'::text, now()),
  constraint automailsend_global_settings_singleton check (id = 1)
);

-- 8. Enable RLS on all tables
alter table public.automailsend_app_state enable row level security;
alter table public.automailsend_recipients enable row level security;
alter table public.automailsend_templates enable row level security;
alter table public.automailsend_sent_log enable row level security;
alter table public.automailsend_execution_logs enable row level security;
alter table public.automailsend_global_settings enable row level security;

-- 9. Policies — users can only see/edit their own rows (admin routes use the service-role key, which
--    bypasses RLS entirely, so no separate admin policy is needed)
create policy "Users can view own app_state" on public.automailsend_app_state for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own app_state" on public.automailsend_app_state for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own app_state" on public.automailsend_app_state for update to authenticated using (auth.uid() = user_id);

create policy "Users can view own recipients" on public.automailsend_recipients for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own recipients" on public.automailsend_recipients for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own recipients" on public.automailsend_recipients for update to authenticated using (auth.uid() = user_id);
create policy "Users can delete own recipients" on public.automailsend_recipients for delete to authenticated using (auth.uid() = user_id);

create policy "Users can view own templates" on public.automailsend_templates for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own templates" on public.automailsend_templates for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own templates" on public.automailsend_templates for update to authenticated using (auth.uid() = user_id);

create policy "Users can view own sent_log" on public.automailsend_sent_log for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own sent_log" on public.automailsend_sent_log for insert to authenticated with check (auth.uid() = user_id);

create policy "Users can view own execution_logs" on public.automailsend_execution_logs for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own execution_logs" on public.automailsend_execution_logs for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own execution_logs" on public.automailsend_execution_logs for update to authenticated using (auth.uid() = user_id);

-- global_settings: readable by anyone (frontend/src/app/api/public/settings/route.ts uses the anon key),
-- writable only via the service-role key (admin API routes), so no write policy for anon/authenticated.
create policy "Anyone can view global_settings" on public.automailsend_global_settings for select to public using (true);

-- 10. Auto-update updated_at on the tables that have it
create or replace function update_modified_column()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

drop trigger if exists update_automailsend_app_state_modtime on public.automailsend_app_state;
create trigger update_automailsend_app_state_modtime
before update on public.automailsend_app_state
for each row execute function update_modified_column();

drop trigger if exists update_automailsend_templates_modtime on public.automailsend_templates;
create trigger update_automailsend_templates_modtime
before update on public.automailsend_templates
for each row execute function update_modified_column();

drop trigger if exists update_automailsend_global_settings_modtime on public.automailsend_global_settings;
create trigger update_automailsend_global_settings_modtime
before update on public.automailsend_global_settings
for each row execute function update_modified_column();

-- 11. Seed the global settings singleton row so the public settings API has something to read
insert into public.automailsend_global_settings (id) values (1) on conflict (id) do nothing;

-- 12. automailsend_job_posts (added 2026-08-17) — one row per distinct scraped LinkedIn post, so
-- automailsend_recipients can reference the SPECIFIC post a contact actually came from instead of
-- duplicating (or, as the old scraper bug did, wrongly aggregating) post text/urls per contact. See
-- backend/src/services/extraction.service.js (extractContactsWithAttribution) and docs/memory.md.
create table if not exists public.automailsend_job_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  source_url text not null,
  context_text text,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  unique(user_id, source_url)
);

alter table public.automailsend_recipients
  add column if not exists job_post_id uuid references public.automailsend_job_posts(id);

alter table public.automailsend_job_posts enable row level security;

create policy "Users can view own job_posts" on public.automailsend_job_posts for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own job_posts" on public.automailsend_job_posts for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own job_posts" on public.automailsend_job_posts for update to authenticated using (auth.uid() = user_id);

-- 13. automailsend_role_defs (added 2026-08-17) — replaces the old hardcoded 4-value Role type. `key` is
-- what's stored in the `role` column on recipients/templates/sent_log (already plain text, no DB change
-- needed there); `label` is what's shown in the UI. User-owned and freely extensible — see docs/memory.md.
create table if not exists public.automailsend_role_defs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  key text not null,
  label text not null,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  unique(user_id, key)
);

alter table public.automailsend_role_defs enable row level security;

create policy "Users can view own role_defs" on public.automailsend_role_defs for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own role_defs" on public.automailsend_role_defs for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own role_defs" on public.automailsend_role_defs for update to authenticated using (auth.uid() = user_id);
create policy "Users can delete own role_defs" on public.automailsend_role_defs for delete to authenticated using (auth.uid() = user_id);

-- 14. automailsend_smtp_accounts (added 2026-08-17) — replaces the single SMTP config on
-- automailsend_app_state.config with N accounts per user, each with its own daily send cap, so volume can
-- be pooled across mailboxes instead of one account absorbing all sends. Old app_state.config/smtp_email/
-- smtp_password/daily_mail_limit are left in place, unused (no real accounts existed to migrate). See
-- backend/src/workers/automail.worker.js / batchSend.worker.js and docs/memory.md.
create table if not exists public.automailsend_smtp_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  label text default '',
  provider text default 'gmail',
  email text not null,
  app_password text not null,
  host text default 'smtp.gmail.com',
  port integer default 465,
  from_email text default '',
  from_name text default '',
  daily_limit integer default 50,
  is_verified boolean default false,
  is_active boolean default true,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now()),
  unique(user_id, email)
);

alter table public.automailsend_sent_log
  add column if not exists smtp_account_id uuid references public.automailsend_smtp_accounts(id);

alter table public.automailsend_smtp_accounts enable row level security;

create policy "Users can view own smtp_accounts" on public.automailsend_smtp_accounts for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own smtp_accounts" on public.automailsend_smtp_accounts for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own smtp_accounts" on public.automailsend_smtp_accounts for update to authenticated using (auth.uid() = user_id);
create policy "Users can delete own smtp_accounts" on public.automailsend_smtp_accounts for delete to authenticated using (auth.uid() = user_id);

drop trigger if exists update_automailsend_smtp_accounts_modtime on public.automailsend_smtp_accounts;
create trigger update_automailsend_smtp_accounts_modtime
before update on public.automailsend_smtp_accounts
for each row execute function update_modified_column();

-- 15. Personalization fix (2026-08-17) — the LinkedIn post's author name was already being extracted
-- (extraction.service.js's `actorName`) to help attribute a contact to its owning post, then thrown away
-- instead of being kept. Persisting it lets templates/AI address a real person instead of guessing one.
-- Denormalized onto recipients too (like context_text/source_url already are) so sending doesn't need a
-- join back to job_posts. See ai.service.js / scraper.worker.js and docs/memory.md.
alter table public.automailsend_job_posts
  add column if not exists author_name text;

alter table public.automailsend_recipients
  add column if not exists author_name text;

-- 16. Candidate profile (2026-08-17) — structured, user-controlled contact info backing the
-- {{candidate_*}} template variables (see docs/architecture.md's "Template variables" section). Extends
-- automailsend_app_state like candidate_info/automail/auto_fetch settings already do, rather than a new
-- table — this is one-per-person data, not per-role. `candidate_info` (the free-text blurb) is unchanged.
alter table public.automailsend_app_state
  add column if not exists candidate_name text default '',
  add column if not exists candidate_email text default '',
  add column if not exists candidate_phone text default '',
  add column if not exists candidate_portfolio_url text default '',
  add column if not exists candidate_resume_url text default '';

-- 17. Jobs & Roles unification (2026-08-17) — each role now carries its own LinkedIn search
-- keywords/aliases plus job-search "rules", instead of keywords living separately in the AutoFetch
-- config. automailsend_app_state.auto_fetch_keywords/auto_fetch_template_role become unused (left in
-- place, same precedent as delay_sec/the old ai_prompt/app_state.config — no real keyword data existed
-- yet to migrate). See backend/src/workers/scraper.worker.js and docs/memory.md.
alter table public.automailsend_role_defs
  add column if not exists keywords text[] default '{}',
  add column if not exists work_mode text default 'any', -- remote | onsite | hybrid | any
  add column if not exists salary_expectation text default '',
  add column if not exists preferred_location text default '',
  add column if not exists other_notes text default '';

-- 18. Jobs & Roles: fixed-option fields (2026-08-17, same day) — operator wants as few free-text areas
-- as possible ("fixed context = the AI consumes less/more consistent content"). salary_expectation
-- (free text) is replaced by structured currency/period/min/max; preferred_location (free text) is
-- replaced by preferred_locations (a keyword-chip list, same UX as the search-keywords field, just a
-- separate list). Both old columns are left in place, unused — same precedent as every other
-- superseded column this project (delay_sec / old ai_prompt / app_state.config). New fixed-option
-- fields added for common criteria the operator called out (employment type directly motivated by the
-- internship use case that started this whole thread): employment_type, company_size, visa_sponsorship.
-- other_notes remains the single free-text catch-all for anything not covered by a fixed field.
alter table public.automailsend_role_defs
  add column if not exists salary_currency text default 'USD',
  add column if not exists salary_period text default 'annual', -- hourly | monthly | annual
  add column if not exists salary_min integer,
  add column if not exists salary_max integer,
  add column if not exists preferred_locations text[] default '{}',
  add column if not exists employment_type text default 'any', -- full-time | part-time | contract | internship | any
  add column if not exists company_size text default 'any',    -- startup | small | medium | large | enterprise | any
  add column if not exists visa_sponsorship text default 'any'; -- required | not-required | any

-- 19. JAMS — job match scoring (2026-08-18). Scraped posts carry no structured job data (no title/salary/
-- location columns anywhere, only a free-text context_text snippet), so "matching against a role's rules"
-- is an AI read of that snippet judged against the role's structured criteria, not a SQL comparison. Scored
-- automatically once per newly-seen job post at scrape time (skipped for roles with no real criteria set,
-- so match_score stays null rather than a meaningless value). Denormalized onto recipients too, same
-- reasoning as author_name/context_text/source_url. See backend/src/services/ai.service.js,
-- backend/src/workers/scraper.worker.js, frontend/src/components/JamsTab.tsx, docs/memory.md.
alter table public.automailsend_job_posts
  add column if not exists match_score integer,          -- 0-100, null = not yet analyzed / no criteria
  add column if not exists match_reasoning text,          -- one short AI sentence
  add column if not exists match_analyzed_at timestamptz;

alter table public.automailsend_recipients
  add column if not exists match_score integer,
  add column if not exists match_reasoning text,
  add column if not exists match_analyzed_at timestamptz;

-- 20. Template library redesign (2026-08-18) — automailsend_templates goes from exactly one row per role
-- (unique(user_id, role)) to a real library: multiple named templates per role, one flagged default,
-- any subset flagged in_randomizer so a send can pick randomly among them instead of always using the
-- default (per-recipient — see backend/src/lib/templatePicker.js). Every existing row was functionally
-- "the" template for its role, so it's backfilled to is_default = true rather than left false.
alter table public.automailsend_templates
  add column if not exists label text not null default 'Default',
  add column if not exists is_default boolean not null default false,
  add column if not exists in_randomizer boolean not null default false;

update public.automailsend_templates set is_default = true where is_default = false;

alter table public.automailsend_templates drop constraint if exists automailsend_templates_user_id_role_key;

-- automailsend_templates never had a delete policy (fine when it was upsert-only; real per-row deletion
-- is now a normal library operation, mirroring automailsend_role_defs's delete policy).
drop policy if exists "Users can delete own templates" on public.automailsend_templates;
create policy "Users can delete own templates" on public.automailsend_templates for delete to authenticated using (auth.uid() = user_id);

-- automailsend_resumes — a separate library from email templates, deliberately: rotating resume file
-- choice independently of pitch text (or vice versa) instead of the two being locked together. Same
-- shape/pattern as automailsend_templates (label, is_default, in_randomizer), files only, no subject/body.
create table if not exists public.automailsend_resumes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  role text not null,
  label text not null default 'Resume',
  files jsonb not null default '[]'::jsonb, -- same Attachment[] shape as automailsend_templates.files
  is_default boolean not null default false,
  in_randomizer boolean not null default false,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now())
);

alter table public.automailsend_resumes enable row level security;

create policy "Users can view own resumes" on public.automailsend_resumes for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own resumes" on public.automailsend_resumes for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own resumes" on public.automailsend_resumes for update to authenticated using (auth.uid() = user_id);
create policy "Users can delete own resumes" on public.automailsend_resumes for delete to authenticated using (auth.uid() = user_id);

drop trigger if exists update_automailsend_resumes_modtime on public.automailsend_resumes;
create trigger update_automailsend_resumes_modtime
before update on public.automailsend_resumes
for each row execute function update_modified_column();

-- 21. Resume Builder (2026-08-18) — structured resume data (personal info, summary, experience, education,
-- skills, projects, certifications, languages) so a resume can be filled section-by-section with a live
-- preview and exported, distinct from automailsend_resumes (uploaded resume FILES used for outreach
-- attachments — a built resume can be exported and saved there too, but the two tables serve different
-- things: structured editable data vs. a finished file). One JSONB blob for the sections — matches this
-- schema's existing convention (files/details jsonb) rather than normalizing six sub-sections into six
-- tables for data that's only ever read/written whole. See docs/architecture.md.
create table if not exists public.automailsend_resume_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  label text not null default 'My Resume',
  template_id text not null default 'modern',
  data jsonb not null default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now())
);

alter table public.automailsend_resume_profiles enable row level security;

create policy "Users can view own resume_profiles" on public.automailsend_resume_profiles for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own resume_profiles" on public.automailsend_resume_profiles for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own resume_profiles" on public.automailsend_resume_profiles for update to authenticated using (auth.uid() = user_id);
create policy "Users can delete own resume_profiles" on public.automailsend_resume_profiles for delete to authenticated using (auth.uid() = user_id);

drop trigger if exists update_automailsend_resume_profiles_modtime on public.automailsend_resume_profiles;
create trigger update_automailsend_resume_profiles_modtime
before update on public.automailsend_resume_profiles
for each row execute function update_modified_column();

-- 22. Sent-log template/resume snapshot (2026-08-18) — once a role can have multiple templates/resumes
-- with randomization (Section 20), the send history had no record of *which* variant actually went to a
-- given recipient. A label snapshot (not a foreign key — templates/resumes get edited or deleted later,
-- and the log should reflect what was true at send time, not what's true now) closes that gap.
alter table public.automailsend_sent_log
  add column if not exists template_label text,
  add column if not exists resume_label text;

-- 23. Platform-managed AI (2026-08-18) — replaces per-user bring-your-own-key AI with the platform's own
-- Gemini key (server-side, never exposed to the client) and an admin-granted credit balance. See
-- docs/architecture.md. ai_provider/ai_api_key above are left in place, unused, per this project's usual
-- "don't delete superseded columns" precedent.
alter table public.automailsend_app_state
  add column if not exists ai_personalization_enabled boolean default false,
  add column if not exists ai_credits integer default 20;

-- 24. AI tab — temperature + match strictness (2026-08-18). temperature feeds every Gemini call's
-- generationConfig; match_strictness gates automail.worker.js's fully-automated background loop only
-- (never JAMS's manual/bulk sends) — a recipient whose scored job post falls below this is skipped
-- entirely, no template/AI/send/credit spent. 0 = off (today's behavior). See docs/architecture.md.
alter table public.automailsend_app_state
  add column if not exists ai_temperature real default 0.4,
  add column if not exists ai_match_strictness integer default 0;

-- 25. Reply monitoring (2026-08-19) — IMAP-polling inbound replies into JAMS. Per-account opt-in
-- (reuses that account's existing app_password — Gmail/Outlook app passwords work for both SMTP and
-- IMAP, so no new secret to collect). message_id is captured from nodemailer's sendMail() result at
-- send time so an inbound reply's In-Reply-To/References headers can be matched back to it; a
-- sender+subject fallback covers clients that mangle threading headers. automailsend_replies only ever
-- holds attributable matches, never a dump of the whole inbox. See docs/architecture.md.
alter table public.automailsend_smtp_accounts
  add column if not exists imap_enabled boolean default false,
  add column if not exists imap_host text,
  add column if not exists imap_port integer default 993,
  add column if not exists imap_last_polled_at timestamp with time zone;

alter table public.automailsend_sent_log
  add column if not exists message_id text;

alter table public.automailsend_recipients
  add column if not exists has_replied boolean default false,
  add column if not exists replied_at timestamp with time zone,
  add column if not exists reply_count integer default 0;

create table if not exists public.automailsend_replies (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users not null,
  smtp_account_id uuid references public.automailsend_smtp_accounts(id),
  recipient_id uuid references public.automailsend_recipients(id),
  sent_log_id uuid references public.automailsend_sent_log(id),
  from_email text not null,
  subject text,
  body_snippet text,
  message_id text not null,
  in_reply_to text,
  match_method text, -- 'header' | 'sender_subject'
  received_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  unique(user_id, message_id)
);

alter table public.automailsend_replies enable row level security;

drop policy if exists "Users can view own replies" on public.automailsend_replies;
create policy "Users can view own replies" on public.automailsend_replies
  for select to authenticated using (auth.uid() = user_id);
-- no insert/update/delete policy: only the backend service-role key writes this table (bypasses RLS)

-- 26. Recruiter portal + AI-assisted ATS (2026-08-19). Recruiter is a *capability*, not a separate
-- account type — any authenticated user can self-serve activate it (a row in
-- automailsend_recruiter_profiles is what unlocks the Recruiter tab, same "existence signals capability"
-- pattern as everything else here). This is the first cross-user-visible data in the whole schema: open
-- job postings are readable by any authenticated candidate, not just their own row. Applications carry a
-- resume SNAPSHOT (resume_data jsonb / resume_file_url+name), not a live FK, same reasoning as
-- sent_log's template_label/resume_label — a later resume edit/delete must never corrupt application
-- history. All inserts into automailsend_job_applications go through /api/jobs/apply (service-role key,
-- Bearer-token authenticated) rather than a client-side insert, so AI-credit spending is always
-- server-verified. See docs/architecture.md.
create table if not exists public.automailsend_recruiter_profiles (
  user_id uuid primary key references auth.users not null,
  company_name text default '',
  ats_ai_enabled boolean default false,
  ats_ai_credits integer default 20,
  created_at timestamp with time zone default timezone('utc'::text, now())
);
alter table public.automailsend_recruiter_profiles enable row level security;
drop policy if exists "Recruiter sees own profile" on public.automailsend_recruiter_profiles;
create policy "Recruiter sees own profile" on public.automailsend_recruiter_profiles
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Recruiter can create own profile" on public.automailsend_recruiter_profiles;
create policy "Recruiter can create own profile" on public.automailsend_recruiter_profiles
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "Recruiter can update own profile" on public.automailsend_recruiter_profiles;
create policy "Recruiter can update own profile" on public.automailsend_recruiter_profiles
  for update to authenticated using (auth.uid() = user_id);

create table if not exists public.automailsend_job_postings (
  id uuid primary key default gen_random_uuid(),
  recruiter_id uuid references auth.users not null,
  title text not null,
  company text default '',
  description text not null,
  location text default '',
  work_mode text default 'any',
  employment_type text default 'full-time',
  salary_currency text default 'USD',
  salary_period text default 'annual',
  salary_min integer,
  salary_max integer,
  status text default 'open', -- 'open' | 'closed'
  created_at timestamp with time zone default timezone('utc'::text, now()),
  updated_at timestamp with time zone default timezone('utc'::text, now())
);
alter table public.automailsend_job_postings enable row level security;
drop policy if exists "Anyone can view open postings, owner sees own" on public.automailsend_job_postings;
create policy "Anyone can view open postings, owner sees own" on public.automailsend_job_postings
  for select to authenticated using (status = 'open' or auth.uid() = recruiter_id);
drop policy if exists "Recruiter can post (unless blocked)" on public.automailsend_job_postings;
create policy "Recruiter can post (unless blocked)" on public.automailsend_job_postings
  for insert to authenticated with check (
    auth.uid() = recruiter_id
    and not exists (select 1 from public.automailsend_app_state s where s.user_id = auth.uid() and s.is_blocked = true)
  );
drop policy if exists "Recruiter can update own postings" on public.automailsend_job_postings;
create policy "Recruiter can update own postings" on public.automailsend_job_postings
  for update to authenticated using (auth.uid() = recruiter_id);
drop policy if exists "Recruiter can delete own postings" on public.automailsend_job_postings;
create policy "Recruiter can delete own postings" on public.automailsend_job_postings
  for delete to authenticated using (auth.uid() = recruiter_id);

create table if not exists public.automailsend_job_applications (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.automailsend_job_postings(id) not null,
  candidate_id uuid references auth.users not null,
  candidate_name text default '',
  candidate_email text default '',
  candidate_phone text default '',
  cover_note text default '',
  resume_data jsonb,
  resume_file_url text,
  resume_file_name text,
  status text default 'submitted', -- 'submitted' | 'shortlisted' | 'rejected'
  ai_score integer,
  ai_reasoning text,
  ai_analyzed_at timestamp with time zone,
  created_at timestamp with time zone default timezone('utc'::text, now()),
  unique(job_id, candidate_id)
);
alter table public.automailsend_job_applications enable row level security;
drop policy if exists "Candidate sees own applications" on public.automailsend_job_applications;
create policy "Candidate sees own applications" on public.automailsend_job_applications
  for select to authenticated using (auth.uid() = candidate_id);
drop policy if exists "Recruiter sees applications to own postings" on public.automailsend_job_applications;
create policy "Recruiter sees applications to own postings" on public.automailsend_job_applications
  for select to authenticated using (
    auth.uid() = (select recruiter_id from public.automailsend_job_postings where id = job_id)
  );
drop policy if exists "Recruiter can update applications to own postings" on public.automailsend_job_applications;
create policy "Recruiter can update applications to own postings" on public.automailsend_job_applications
  for update to authenticated using (
    auth.uid() = (select recruiter_id from public.automailsend_job_postings where id = job_id)
  );
-- no insert policy for authenticated clients: all inserts go through /api/jobs/apply (service-role key)

-- 27. Candidate profile as knowledge base + per-role module selection (2026-08-19). Operator: most
-- candidates target one role, so the *role* is the thin, disposable layer (search criteria + which
-- profile content applies) and the *profile* is the permanent one (identity, bio, every experience/
-- education/project/certification/skill they've ever had) — build it once, keep it current, reuse a
-- hand-picked subset per role. New dedicated table (mirrors automailsend_recruiter_profiles' one-row-
-- per-user shape) rather than more jsonb columns on the already-large automailsend_app_state; that
-- table's candidate_name/email/phone/portfolio_url/resume_url columns are left in place, unused — same
-- precedent as every other superseded column this project (see section 17's comment). Sub-sections
-- (education/experience/projects/certifications/skills/languages) are jsonb arrays of objects with a
-- stable `id`, same shape as ResumeData's equivalents in the Resume Builder (section 21) — skills gained
-- an id here (`{id, name}`) since a role now selects a *subset* of them, unlike a resume's own full copy.
create table if not exists public.automailsend_candidate_profiles (
  user_id uuid primary key references auth.users not null,
  name text default '',
  email text default '',
  phone text default '',
  address text default '',
  bio text default '',
  portfolio_url text default '',
  resume_url text default '',
  education jsonb not null default '[]'::jsonb,
  experience jsonb not null default '[]'::jsonb,
  projects jsonb not null default '[]'::jsonb,
  certifications jsonb not null default '[]'::jsonb,
  skills jsonb not null default '[]'::jsonb,
  languages jsonb not null default '[]'::jsonb,
  updated_at timestamp with time zone default timezone('utc'::text, now())
);

alter table public.automailsend_candidate_profiles enable row level security;

drop policy if exists "Users view own candidate profile" on public.automailsend_candidate_profiles;
create policy "Users view own candidate profile" on public.automailsend_candidate_profiles
  for select to authenticated using (auth.uid() = user_id);
drop policy if exists "Users insert own candidate profile" on public.automailsend_candidate_profiles;
create policy "Users insert own candidate profile" on public.automailsend_candidate_profiles
  for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "Users update own candidate profile" on public.automailsend_candidate_profiles;
create policy "Users update own candidate profile" on public.automailsend_candidate_profiles
  for update to authenticated using (auth.uid() = user_id);

-- Per-role module selection: which profile items (by id) get pulled into a resume composed for this
-- role, plus availability (fixed-option, same "fixed context over free text" convention as every other
-- RoleDef field — see section 18). languages is deliberately not selectable per-role (rarely role-
-- specific, always carried through whole by composeResumeData).
alter table public.automailsend_role_defs
  add column if not exists availability text default '', -- '' | immediate | 2-weeks | 1-month | 3-plus-months
  add column if not exists selected_experience_ids jsonb not null default '[]'::jsonb,
  add column if not exists selected_education_ids jsonb not null default '[]'::jsonb,
  add column if not exists selected_project_ids jsonb not null default '[]'::jsonb,
  add column if not exists selected_certification_ids jsonb not null default '[]'::jsonb,
  add column if not exists selected_skill_ids jsonb not null default '[]'::jsonb;

-- 28. Email Templates redesign (2026-08-19) — kills the randomization mechanism (is_default/in_randomizer
-- + pickFromPool, section 20 above) in favor of an explicit per-role send mode plus per-template resume/
-- attachment ownership. is_default/in_randomizer and the whole automailsend_resumes table (section 20)
-- are left in place, unused — same "superseded, never dropped" precedent as delay_sec/old ai_prompt
-- elsewhere in this file. See docs/architecture.md's "Email Templates redesign" section.
--
-- automailsend_role_defs: which of the 3 modes this role sends with (manual | ai-select | ai-write), and
-- (manual mode only) which specific template row. on delete set null so a deleted template just reverts
-- the role to "no template selected" rather than failing the delete.
alter table public.automailsend_role_defs
  add column if not exists email_send_mode text not null default 'manual',
  add column if not exists selected_template_id uuid references public.automailsend_templates(id) on delete set null;

-- automailsend_templates: each template now owns its own resume choice (an uploaded file, or a PDF
-- snapshot generated from a Resume Builder profile — see lib/resumePdf.tsx) and its own "other" files
-- (already existed as `files`), plus two opt-in checkboxes pulling from the candidate's global defaults
-- below instead of re-adding the same file to every template.
alter table public.automailsend_templates
  add column if not exists resume_source text not null default 'none', -- none | file | builder
  add column if not exists resume_file jsonb,
  add column if not exists resume_profile_id uuid references public.automailsend_resume_profiles(id) on delete set null,
  add column if not exists resume_profile_snapshot jsonb,
  add column if not exists use_global_resume boolean not null default false,
  add column if not exists use_global_files boolean not null default false;

-- automailsend_candidate_profiles: one global resume + one global "extra files" list (the "somewhere
-- else" the operator asked for) — same file-or-builder shape as a template's own resume, applied
-- automatically for any template with use_global_resume/use_global_files checked, and always for roles
-- in "ai-write" mode (no template involved, so this is the only attachment source available to them).
alter table public.automailsend_candidate_profiles
  add column if not exists global_resume_source text default 'none',
  add column if not exists global_resume_file jsonb,
  add column if not exists global_resume_profile_id uuid references public.automailsend_resume_profiles(id) on delete set null,
  add column if not exists global_resume_profile_snapshot jsonb,
  add column if not exists global_files jsonb not null default '[]'::jsonb;

-- 29. Attachments move to a role-level module selection (2026-08-19, corrected same day from section 28's
-- per-template/global-checkbox design) — a role now selects which of the candidate's profile files apply
-- to it, same pattern as selected_experience_ids etc. section 28's resume_*/use_global_* columns on
-- automailsend_templates are dropped from active use (left in place, unused); automailsend_candidate_profiles
-- .global_files is REPURPOSED (not renamed) as the profile's unified files pool — see
-- docs/architecture.md's "Email Templates redesign" section.
-- RETIRED 2026-08-20 (same day as section 31, "Additional files" removed per operator ask) — a role's
-- send now attaches its resume only. Column left in place, unread by anything (same "superseded, never
-- dropped" precedent as every other retired column here), in case the feature is wanted again later.
alter table public.automailsend_role_defs
  add column if not exists selected_file_ids jsonb not null default '[]'::jsonb;

-- 30. Resume hierarchy: one resume per role, with a candidate-level global default (2026-08-20). Section
-- 29's selected_file_ids treated "the resume" as just another entry in an unranked subset — nothing
-- distinguished it from a portfolio file, and nothing capped a role at exactly one. Operator: dismiss
-- multi-resume-per-role entirely; one global default resume at the top, each role inherits it unless
-- explicitly overridden with its own, and selected_file_ids narrows to "additional files" alongside that
-- one resume. Both new columns are plain nullable text pointing at an Attachment.id inside the existing
-- jsonb pools (global_files / a role's own resume choice) — not a real FK, same reasoning as
-- selected_file_ids/selected_template_id: an id into a jsonb array has no table row to reference. See
-- docs/architecture.md's "Email Templates redesign" section's newest follow-up.
alter table public.automailsend_candidate_profiles
  add column if not exists global_resume_id text; -- an Attachment.id from global_files; null = none set yet

alter table public.automailsend_role_defs
  add column if not exists resume_id text; -- an Attachment.id from the candidate's files; null = inherit global_resume_id

-- 31. Resume Builder redesign: role-tabbed, three authoring modes (2026-08-20, same-day follow-up).
-- Operator: the Resume Builder tab was a flat profiles list + scattered toolbar buttons with no per-role
-- structure. New: role tabs, same as Roles/Email Templates/Resumes-Configuration, each with exactly three
-- modes — "from your profile" (composed live from the candidate's profile + that role's module selection,
-- the default), "start from scratch" (today's ordinary blank builder, no outside effects), "upload your
-- own" (section 30's resume_id override, unchanged). Both new columns are pure authoring/UI state — never
-- read by send-time resolution (lib/emailResolve.js's resolveRoleResume/resolveRoleAttachments are
-- untouched by this section; a role's resume is still whatever resume_id points at). See
-- docs/architecture.md's "Email Templates redesign" section's newest follow-up.
alter table public.automailsend_role_defs
  add column if not exists resume_mode text not null default 'profile'; -- profile | scratch | upload

alter table public.automailsend_role_defs
  add column if not exists scratch_resume_profile_id uuid references public.automailsend_resume_profiles(id) on delete set null; -- this role's "start from scratch" draft, if any


-- 2026-08-25: account-wide daily send cap, admin-configurable, no billing/plan system yet so this is one
-- global ceiling for now (see docs/memory.md) rather than per-user — the effective limit a candidate sees
-- is min(this, their own automailsend_app_state.daily_mail_limit, their connected SMTP accounts' pool).
alter table public.automailsend_global_settings
  add column if not exists max_daily_send_limit integer not null default 100;


-- 2026-08-25 (operator ask — "limit the number of keywords in a package... limit the interval searches
-- on those packages") — the first lever toward real plan tiers, scoped deliberately small for now: manual
-- admin overrides per user, not a self-serve billing/packages system (that's real future work once this
-- becomes "a complete SaaS product", per the operator). Both nullable — null means "no override, behave
-- exactly as today" for every existing account, so this ships with zero behavior change until an admin
-- explicitly sets one.
--  - max_keywords: caps a candidate's TOTAL search keywords across every role combined (JobsRolesTab.tsx
--    enforces it client-side; there's also a separate, pre-existing per-role cap of 15, MAX_CHIPS in that
--    same file — this is an additional account-wide ceiling on top of that, not a replacement).
--  - min_fetch_interval_override: this candidate's own floor for "Run interval (minutes)" in the LinkedIn
--    Auto-Fetch config (AutoFetchModal.tsx), overriding the app's default 180-minute floor. Distinct from
--    automailsend_global_settings.min_fetch_interval, which is a *global* floor applied to everyone with
--    no override set — this is the per-user exception on top of that global default.
alter table public.automailsend_app_state
  add column if not exists max_keywords integer;

alter table public.automailsend_app_state
  add column if not exists min_fetch_interval_override integer;

-- 2026-08-25 (operator ask — real AI-based job-post filtering, not pure keyword matching): a role's
-- keyword list splits into "Include Keywords" (the pre-existing `keywords` column — still what's searched
-- in LinkedIn's own search bar) and a new "Exclude Keywords" list, plus a free-text `ai_instructions` field
-- that's read directly by the AI matcher (ai.service.js's scoreJobMatch) and takes priority over both
-- keyword lists when they conflict. Both default to "nothing set" so every existing role's behavior is
-- unchanged until a candidate fills them in. See RoleDef in lib/types.ts.
alter table public.automailsend_role_defs
  add column if not exists exclude_keywords text[] default '{}',
  add column if not exists ai_instructions text default '';

-- 2026-08-26 (operator ask — "if I want to select multiple company sizes... or I want to skip enterprise,
-- I need to have that"): company_size's single-select "any"-or-one-value column is retired from the UI in
-- favor of company_sizes, a real multi-select. Backfilled from any existing single value so no one's prior
-- selection is silently lost; company_size itself is left in place, unread going forward (same
-- "superseded, never dropped" precedent as every other retired column here) rather than altered in place,
-- since converting its type live carries real risk for no benefit over just adding the new column.
alter table public.automailsend_role_defs
  add column if not exists company_sizes text[] default '{}';

update public.automailsend_role_defs
  set company_sizes = array[company_size]
  where company_size is not null and company_size <> 'any'
    and (company_sizes is null or company_sizes = '{}');
