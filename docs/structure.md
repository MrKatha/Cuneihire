# Structure

## `frontend/` (Next.js 16, TypeScript)
- `src/app/[[...tab]]/page.tsx` — the whole app is one SPA-style catch-all route, tab-driven (not per-tab routes)
- `src/app/login/`, `src/app/signup/` — auth pages
- `src/app/api/send/` — synchronous single-email send (Nodemailer); `QuickSendModal`'s only caller
- `src/app/api/ai-enhance/` — synchronous AI draft-polish for `QuickSendModal` (calls `lib/aiClient.ts`)
- `src/app/api/resume-import/` — (2026-08-18) extracts text from an uploaded PDF (`pdf-parse`) and
  structures it into `ResumeData` via `lib/aiClient.ts`'s `parseResumeText`, for `ResumeBuilder`'s AI import
- `src/app/api/verify/`, `src/app/api/verify-linkedin/` — SMTP verify, LinkedIn cookie verify
- `src/app/api/admin/global-settings/`, `src/app/api/admin/users/[userId]/` — admin-only, gated by `verifyAdmin()`
- `src/app/api/public/settings/` — unauthenticated settings read
- `src/app/api/jobs/apply/`, `src/app/api/jobs/score-application/` — (2026-08-19, recruiter portal)
  server-side application submit + AI-ATS scoring, `Authorization: Bearer` auth via `getAuthedUserId()`,
  same pattern as `ai-enhance`/`resume-import` — see [architecture.md](architecture.md)'s "Recruiter
  portal" section
- `src/components/` — one component per feature panel: `SmtpConfigPanel` (2026-08-19: also owns the
  per-account "Enable reply monitoring" IMAP opt-in), `RoleTemplates` (the "Templates" sub-tab of the
  "Email Templates" section — multiple named templates per role, purely wording now (label/subject/
  content); 2026-08-19: randomization removed; 2026-08-20: split into Templates/Configuration sub-tabs —
  the per-role send mode moved to the sibling `EmailConfigTab`, so `RoleTemplates` lost its own outer
  `.panel` wrapper (now owned once by `page.tsx`, wrapping both sub-tabs). The resume attachment moved
  entirely onto the role, set on the Resumes tab's own Builder sub-tab (2026-08-20, Resume Builder
  redesign — see `ResumeBuilder` below) — see [architecture.md](architecture.md)'s "Email Templates
  redesign" section and its follow-ups),
  `EmailConfigTab` (2026-08-20, new — the Email Templates section's "Configuration" sub-tab: a role-tab bar
  + the `EMAIL_SEND_MODES` radios, moved out of `RoleTemplates`; three modes again — manual, "let AI
  choose," and "let AI write it," the last restored the same day it was dropped, per operator ask), `JobsRolesTab` (per-role search keywords + job-search
  rules + a "Modules for this role" checklist since 2026-08-19 — which of the profile's items this role
  pulls into a composed resume/attaches to its emails, each with select-all/select-none — five checklists
  (Experience/Education/Projects/Certifications/Skills; a sixth, Files, lived here briefly same-day before
  moving to `ResumeConfigTab` on 2026-08-20) — + the matched-job-post board; its own
  sidebar tab ("Roles"), separate from `ProfileTab`'s "My Profile" tab — briefly merged into one section
  with an internal toggle, reverted same day for easier navigation; the five module checklists are an
  accordion since 2026-08-20 — one `expandedModule` key in `JobsRolesTab`, not five independent toggles),
  `AddProfileItemModal` (2026-08-19, new: a floating "+ Add experience/education/project/certification"
  form opened from `JobsRolesTab`'s checklists — writes into the same canonical profile `ProfileTab` edits
  and auto-selects the new item for the open role, so a candidate never has to leave the Roles tab to
  update My Profile; gained a `"skills"` section 2026-08-20 (comma-separated, dedup via `existingSkillNames`)
  when Skills dropped its own separate inline adder for this same pop-up; never covered Files — that always
  had its own lighter inline upload/generate quick-add, now living in `ResumeConfigTab`),
  `ProfileTab` (2026-08-19: the permanent knowledge base — identity/bio/address plus
  experience/education/projects/certifications/skills/languages, reusing `ResumeBuilder`'s section editors
  — was just a 5-field contact card before, see [architecture.md](architecture.md)'s "Profile as knowledge
  base" section; briefly held a Files section same-day, moved to `ResumeConfigTab` on 2026-08-20 per
  operator ask to keep everything resume-related on the Resumes tab), `JamsTab` (the unified
  lifecycle hub — every contact found, bulk/per-row send actions with "queued" feedback, per-contact send
  history, and a collapsible `ExecutionLogsPanel` for automation activity, all in one place; absorbed the
  old `RecipientManager`, `SendPanel`, and `QuickSendTab`, which are deleted; also shows a "↩ Replied"
  badge + the contact's actual reply thread now (2026-08-19, reply monitoring) — see
  [architecture.md](architecture.md)), `QuickSendModal` (the "+ Quick Send" button's modal — HR contact
  fields, a template picker (auto/custom/specific), attachments resolved from the role's own file
  selection (no separate resume picker any more), AI enhance, sends
  synchronously via `/api/send`), `AutomailModal` (background-sending mechanics only — enable + daily
  limit; AI settings moved out, 2026-08-18), `AITab` (2026-08-18, new: its own sidebar tab — AI
  enable/disable, credit balance, temperature, and job-match strictness — see
  [architecture.md](architecture.md)'s "The AI tab" section), `AutoFetchModal` (LinkedIn scrape mechanics
  only — keywords live on `JobsRolesTab`), `AdminPortal` (2026-08-19: also grants ATS credits — see
  below), `ExecutionLogsPanel`,
  `ResumeBuilder` (2026-08-18, new: structured section-by-section resume editor with a live preview —
  see [architecture.md](architecture.md)'s "Resume Builder" section; its Experience/Education/Projects/
  Certifications/Languages section editors are exported since 2026-08-19 for `ProfileTab` and
  `AddProfileItemModal` to reuse. Rewritten 2026-08-20 (Resume Builder redesign), then cleaned up again
  same day — role-tab bar (same as Roles/Email Templates/Resumes-Library) with exactly two modes per
  role (a third, "upload", was removed the same day it shipped — see below): "profile" (default —
  composed live from `lib/resumeCompose.ts`'s `composeResumeData`, ephemeral in a per-role `Record` until
  Save, which diffs against the profile via `lib/resumeSync.ts` and may prompt `SyncResumeModal`; has its
  own "Resume name" field defaulting to `"{candidate name} — {role label}"`, since that name is literally
  the emailed attachment's filename), "scratch" (today's original blank-builder behavior, scoped to a
  role via `RoleDef.scratchResumeProfileId` instead of a flat list; empty state offers "+ Start a resume"
  and "✨ Import from an existing resume" as two equal options). A role with no resume resolvable at all
  gets one composed and saved automatically the moment it's opened here in "profile" mode — no click
  required; every save (whether that auto-default, "no edits, re-Save," or a real edit synced/kept local)
  blocks on a colliding name via `lib/resumeNaming.ts` rather than silently renaming (2026-08-20, second
  same-day follow-up — this pass also fixed a real "Maximum update depth exceeded" crash on open, caught
  by an actual Playwright browser test rather than build/lint alone: an inline fallback computation fed the
  pagination effect a new object reference every render; now memoized).
  The live preview is a fixed, non-scrolling single-page "page window" (2026-08-20, third same-day
  follow-up — a full layout rewrite, not the earlier dashed-marker approach, which had a real page-break-
  value bug fixed at the source in `lib/resumePaginate.ts`): `.resume-print-area` is a real-A4-sized
  `overflow:hidden` box, `translateY`'d internally to reveal only the current page, dynamically `zoom`-fit
  to whatever space is available via a `ResizeObserver`. The editor column is the only scrolling pane
  (`overflow-y:auto`, bounded by a pure-CSS flexbox height chain running from `page.tsx`'s `.board` down
  through here) and drives which page the preview shows via `data-atom-key` scroll-position tracking,
  matching the same keys the preview templates' atoms use — manual "Page X of N ‹ ›" nav also works, the
  next scroll just re-syncs afterward. A new `StyleSection` (font/size/line-height/letter-spacing/page-
  padding controls, stored on `ResumeData.style`) sits in the editor column too. See
  [architecture.md](architecture.md)'s "Resume Builder redesign" section and its three cleanup follow-ups),
  `ResumeConfigTab` (2026-08-20, new, then trimmed twice same day — "keep everything resume-related
  on the Resumes tab" per operator ask: started as the candidate's shared Files pool plus a per-role
  resume picker; the per-role picker moved into `ResumeBuilder` in the Resume Builder redesign follow-up.
  Simplified again same day (operator: "that's it, simple") — the "Generate from Resume Builder…"
  dropdown and "🔄 Regenerate" button are gone (a resume you build now always goes through Builder's own
  Save/"Use as resume" flow, which already lands it here); every list row is the resume itself now, with
  an inline-editable name and a radio marking the one candidate-wide default, replacing the standalone
  "Global default resume" card entirely; uploading or renaming to a name already used elsewhere in the
  Library is blocked with an inline error (2026-08-20, second same-day follow-up — same
  `lib/resumeNaming.ts` guard `ResumeBuilder`'s Save/Sync flows use). Sub-tab itself renamed "Configuration" → "Library" — component/
  file name unchanged, same "rename the label, not the file" precedent as `JobsRolesTab.tsx`;
  `ResumeBuilder` and `ResumeConfigTab` are the "Builder"/"Library" sub-tabs `page.tsx` switches between
  under the "Resumes" sidebar tab — `ResumesTab.tsx` itself is still deleted, this is a new,
  differently-shaped component, not its return), `SyncResumeModal` (2026-08-20, new: the "Save to
  Profile & Role" vs "Just this resume" prompt shown from `ResumeBuilder`'s "profile" mode when
  `diffResumeAgainstProfile` finds something new/changed — same modal conventions as
  `AddProfileItemModal`. "Just this resume" reveals a name input same day it shipped — the result is a
  new, separately named Library entry that doesn't replace the role's active resume, not an immediate
  swap. "Save to Profile & Role" now also creates a new instance rather than replacing one in place, and
  reveals the same kind of name-input step if its (reused) name turns out to collide (2026-08-20, second
  same-day follow-up)), `JobBoardTab` (candidate-facing — browse open
  recruiter postings; gained "⚡ Easy Apply" (2026-08-19) next to the manual "Apply" — composes a resume
  from the matched role's modules and opens it for review, see [architecture.md](architecture.md)'s
  "Profile as knowledge base" section),
  `RecruiterTab` (2026-08-19, new: recruiter-facing — posting CRUD, AI-ATS settings; account type is
  chosen once at signup now, not self-serve in-app (same-day follow-up), so a candidate account's version
  of this tab just explains that instead of offering a "Become a Recruiter" button; the sidebar entry
  itself is always visible either way, see [architecture.md](architecture.md)'s "Recruiter portal"
  section), `ApplicantsModal` (2026-08-19, new: per-posting applicant review — status, AI-ATS score,
  manual "Score with AI"), plus supporting modals/UI (`AttachmentPreviewModal`, `CookieHelpModal`,
  `HelpTooltip` (click-to-open modal reference), `HoverHint` (2026-08-19, new: pure-CSS hover popover —
  deliberately distinct from `HelpTooltip`, used by `ResumeBuilder`'s `MarkdownLiteField`), `AutoGrowTextarea`, `LandingPage`,
  `JobPostCard`, `ui/HexMark` — the Cuneihire brand-mark primitive)
- `src/lib/` — `crypto.ts` (encrypts SMTP/session secrets with `ENCRYPTION_KEY` — must match
  `backend/src/lib/crypto.js`), `placeholders.ts`/`aiClient.ts` (mirror
  `backend/src/services/ai.service.js`'s placeholder substitution and AI provider dispatch respectively,
  for the Quick Send modal's synchronous send/enhance path — same "keep in sync" deal as `crypto.ts`;
  `aiClient.ts` also holds the Resume Builder's `parseResumeText` and, since 2026-08-19, the recruiter
  portal's `scoreApplicationMatch`/`checkAtsAiGate`/`spendAtsAiCredit`), `emailResolve.ts` (2026-08-19, new;
  rewritten 2026-08-20 for the one-resume-per-role hierarchy, then again same day when "additional files"
  was removed: mirrors `backend/src/lib/emailResolve.js`'s `resolveRoleResume`/`resolveRoleAttachments` —
  a role's resume (its own override, else the candidate's global default) resolved to a real attachment,
  for `QuickSendModal`'s synchronous client-side send path, same "keep in sync" reasoning; `templatePicker.ts`'s
  old randomization logic is deleted, no consumers left),
  `resumeTemplates/` (2026-08-18, new: `ModernTemplate.tsx`/`ClassicTemplate.tsx` — pure `ResumeData → JSX`
  presentational components for the Resume Builder's live preview), `resumeCompose.ts` (2026-08-19, new:
  `composeResumeData`/`matchRoleToPosting` — pure, no-AI functions turning a candidate profile + a role's
  module selection into a resume, and picking which role a Job Board posting is for; see
  [architecture.md](architecture.md)), `resumeSync.ts` (2026-08-20, new: `diffResumeAgainstProfile`/
  `mergeResumeIntoProfile` — the pure diff/merge pair behind `ResumeBuilder`'s "profile" mode Save prompt;
  additive/edit-in-place only, never removes anything from the shared profile or a role's selection), 
  `resumePdf.tsx` (2026-08-19, new: `useResumeProfilePdf()` — renders
  a saved `ResumeProfile` (or a throwaway `ResumeProfile`-shaped object, id unused) off-screen and turns it
  into a PDF `Attachment` via html2canvas+jsPDF, used from `ResumeBuilder` only as of 2026-08-20
  (`ResumeConfigTab`'s Library no longer generates PDFs itself — a resume you build always goes through
  Builder now). Pagination is content-aware (2026-08-20, bug fix) via `resumePaginate.ts` — see below,
  replacing the old blind fixed-pixel image slicing. The resulting `Attachment.name` used to be slug-
  sanitized (spaces/punctuation → hyphens) for no real reason — the actual storage path is always
  randomized by `storage.ts`'s `uploadAttachment`, `file.name` only ever fed the display/emailed name;
  fixed (2026-08-20, second same-day follow-up, bug fix) to preserve the label as typed, only stripping
  genuinely unsafe path characters; page-padding parity with the live preview added third same-day
  follow-up — this host previously had no padding at all), `resumePaginate.ts` (2026-08-20, new, bug fix:
  `computePageBreaks(containerEl)` — measures every `[data-page-atom="true"]` element and returns page-end
  Y-offsets that never split one, plus (third same-day follow-up) an `atomPage` map of which page each
  `[data-atom-key]` landed on, shared by `resumePdf.tsx` (the real PDF) and `ResumeBuilder.tsx` (the live
  preview's page window + editor scroll-sync) so all three agree. Self-correcting since the third follow-up
  — divides its output by the ancestor chain's active scale factor (`containerRect.width / offsetWidth`)
  so it always returns native-space px, safe to reapply directly as a local `top`/`translateY` regardless of
  transform/zoom in effect; a real bug (not just a UX gap) before this — see
  [architecture.md](architecture.md)),
  `markdownLite.tsx`
  (2026-08-19, new: `renderMarkdownLite` — the
  tiny bullet+bold syntax experience/project descriptions and education notes are written in, parsed to
  JSX for the resume templates' preview/PDF output; bullets render as an explicit "•" glyph, not a native
  `<ul>/<li>`, since 2026-08-20 — html2canvas is unreliable about painting native list markers. The bullet
  regex required a space after the marker; real content — especially AI-imported resume text — often has
  none, so this fell through as plain text; relaxed same day, second follow-up, bug fix),
  `resumeNaming.ts` (2026-08-20, new, second same-day follow-up: `isNameTaken`/`uniqueNameFallback` — the
  shared uniqueness guard every path that sets a resume's name goes through, so nothing can grab the wrong
  resume by name collision; see [architecture.md](architecture.md)),
  `extractEmails.ts`, `jobPosts.ts`,
  `redis.ts`, `storage.ts`, `supabase.ts`, `types.ts`

## `backend/` (Node.js, CommonJS)
- `src/index.js` — process entrypoint; graceful shutdown resets stuck locks/execution logs in Supabase
- `src/scheduler.js` — interval-based scheduler (see `*_INTERVAL_SEC` env vars)
- `trigger.js` — manual one-off CLI trigger (`npm run trigger`)
- `src/config/` — `redis.js`, `supabase.js` clients
- `src/lib/` — `crypto.js` (must match frontend's scheme), `emailResolve.js` (2026-08-19, new; rewritten
  2026-08-20 for the one-resume-per-role hierarchy, then again same day when "additional files" was
  removed: `resolveRoleResume`/`resolveRoleAttachments` — a role's resume (its own override, else the
  candidate's global default) resolved to a real attachment, used by both send workers; replaces the
  deleted `templatePicker.js`'s randomization — see [architecture.md](architecture.md)'s "Email Templates
  redesign" section and its follow-ups),
  `aiCredits.js` (2026-08-18: `spendAiCredit()`, shared by all three workers), `imapPool.js` (2026-08-19:
  `buildImapConfig()`, mirrors `smtpPool.js`'s shape for the reply poller — reuses each account's existing
  `app_password`), `globalSettings.js`, `logger.js`
- `src/queues/` + `src/workers/` — BullMQ queue+worker pairs are effectively dead code (real jobs run
  in-process via `scheduler.js`'s own `setInterval` loops, bypassing Redis — see architecture.md);
  `automail`, `batchSend`, `scraper`, and `replyPoll` (2026-08-19: IMAP-polling inbound replies into JAMS,
  see architecture.md's "Reply monitoring" section) all follow that same direct-call pattern
- `src/services/` — `ai.service.js` (Gemini personalization + JAMS match scoring, platform-managed —
  2026-08-18; 2026-08-19: also `chooseTemplateForJob` for "ai-select" send mode; `generateAiPersonalizedEmail`
  for "ai-write" — dropped 2026-08-19, restored 2026-08-20, `baseTemplate` optional either way),
  `extraction.service.js`
- `src/scripts/` — standalone test scripts (`test_parser.js`, `test_scraper.js`) — not a test suite, run manually
- `ecosystem.config.js` — PM2 config (app name `auto_apply_linkedin_backend`)

## `extension/` (Chrome MV3, plain JS)
- `background.js`, `content.js`, `manifest.json` — extracts LinkedIn `JSESSIONID`, targets
  `bulk-email.ismailabbasi.qzz.io`, `viddr.ismailabbasi.qzz.io`, and localhost

## Database
- `frontend/database/supabase_setup.sql`, `backend/database/supabase_setup.sql` — raw SQL, no ORM/migration
  tool. Kept byte-identical (verified after every change) since 2026-08-17's consolidation — re-copy after
  any edit, apply live via the Supabase Management API (see [architecture.md](architecture.md))
- `automailsend_recruiter_profiles`, `automailsend_job_postings`, `automailsend_job_applications`
  (2026-08-19) — the recruiter portal's tables; `job_postings` is the first table in this schema readable
  cross-user (any authenticated candidate can see an `open` posting, not just its own recruiter) — see
  [architecture.md](architecture.md)'s "Recruiter portal" section
- `automailsend_role_defs.email_send_mode`/`selected_template_id`/`selected_file_ids` (2026-08-19) — the
  2-send-mode + role-level file-selection columns (the file selection was originally per-template +
  global-checkbox, corrected to role-level same day). `automailsend_templates.is_default`/`in_randomizer`/
  `resume_*`/`use_global_*`, and the whole `automailsend_resumes` table, are still physically present but
  unused by this redesign (superseded, not dropped); `automailsend_candidate_profiles.global_files` is
  **repurposed** (not renamed) as the candidate's unified files pool, while that table's other
  `global_resume_*` columns are unused — see [architecture.md](architecture.md)'s "Email Templates
  redesign" section and its same-day follow-up
