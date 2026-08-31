# Memory — agent hand-off

Newest on top. Terse bullets only — done / in-progress / locked decisions / open items. Update every phase.

- **2026-08-31 — DONE: Dual credit system (app_credits + ai_credits) + automated follow-up emails (MVP
  push).** Operator is pushing toward a real launch — 3-5 paying users, 25-50 emails/day each. New
  `app_credits` (default 2000, existing users confirmed migrated to 2000 not 0) is spent on EVERY send
  (manual/template/resume/follow-up), checked as a pre-flight gate in all 3 send paths
  (`automail.worker.js`, `batchSend.worker.js`, `frontend/src/app/api/send/route.ts` — which had **zero
  auth before this**, now uses `getAuthedUserId`). `ai_credits` still spent additionally whenever AI wrote
  the content. New 5th scheduler loop (`backend/src/workers/followUp.worker.js`, not BullMQ, same
  `setInterval` pattern as the other 4) sends up to 3 follow-ups per recipient on a real per-role
  configurable interval (`automailsend_role_defs.follow_up_interval_days`), AI-written by default with an
  optional per-slot template override (`follow_up_template_{1,2,3}_id`). New template variables
  `{{last_sent_date}}`/`{{follow_up_number}}` (10 tokens total now). New UI in `EmailConfigTab.tsx` (interval
  + 3 slot pickers) and both `AdminPortal.tsx`/candidate-side `JamsOverviewTab.tsx` (App Credits stat tile).
  **Also this session**: researched open-source self-hosted alternatives to Apify for the scraping-layer
  backlog idea (`86eyt8mwt`) — JobSpy for multi-platform job scraping (no LinkedIn login needed), pattern-
  guessing + SMTP verification for email discovery (no paid API) — still backlog, not built.
- **2026-08-29 — DONE (spec only): Candidate pricing tiers (`86eyrp54a`).** New `docs/pricing-tiers.md` —
  Free/Pro/Premium, built entirely from the 4 real existing admin-override levers (ai_credits, max_keywords,
  min_fetch_interval_override, daily_mail_limit), no new schema/code. Two real gaps surfaced and documented,
  not fixed: (1) the platform Gemini key is still free-tier, 20 requests/day shared across everyone — AI
  credit numbers in the spec are sized for after that upgrade, don't roll out yet; (2) daily_mail_limit is
  clamped by ONE global `max_daily_send_limit` (100) regardless of tier, so Premium's proposed 150/day cap
  needs that global ceiling raised first. Confirmed `allowed_products` is a dead field (written, never read)
  — can't gate whole features per tier today. Suggested (not built) an optional `plan_tier` label column for
  the admin UI. No self-serve billing — accounts stay admin-created per the 2026-08-26 decision.
- **2026-08-29 — DONE: Cost & usage metering per user (Phase 3 task 1, ClickUp `86eyrp548`).** Two new
  ledgers, `automailsend_ai_usage_log` (real Gemini token counts + $ cost, computed at insert time from a
  runtime-date-branched pricing constant — `getGeminiRates()` in `backend/src/lib/aiUsage.js` and its inline
  twin in `frontend/src/lib/aiClient.ts`, KEEP IN SYNC) and `automailsend_infra_usage_log` (Resend auth-email
  cost, an approximation, keyed by email not user_id since every one of those 4 call sites fires before a
  session exists). `callAiJson` (both codebases, not exported) gained `userId`/`callType` trailing params
  and logs right after the Gemini response arrives, before `JSON.parse` — return shape unchanged, so none of
  the 7 real callers' worker/route branching needed touching. New admin-portal "Cost" tab per user +
  "Total Platform Spend" tile on Overview. **Investigated during planning and scoped down: bulk email sends
  cost the operator $0** (each user sends through their own SMTP, `automailsend_smtp_accounts`) — only
  Resend-billed auth emails (signup/magic-link/reset/OTP) are logged, not bulk sends. No backfill (nothing
  was ever captured historically). Verified live: direct synthetic writes to both new tables via the real
  `logAiUsage`/`/api/log-infra-usage` code paths (not a live worker run — declined to trigger the real
  scraper against production users just to test this), rows landed with correct computed cost, cleaned up
  after.
- **2026-08-26 — DONE: pill multi-select for work mode/employment type/company size.** New shared
  `MultiSelectChipField` in `JobsRolesTab.tsx` (pick-from-a-list-then-remove-the-pill, same visual as the
  pre-existing "Preferred countries" chip field) replaces single-select dropdowns for all three — legacy
  singular columns kept, unread, backfilled once into the new `text[]` arrays. Migrated live.
- **2026-08-26 — DONE: AI include/exclude job matching; "Other notes" removed; matched-post board deleted
  from Roles; Automation moved from JAMS to Settings as Play/Pause.** `RoleDef` gained `excludeKeywords`
  and `aiInstructions` (highest-priority override in `scoreJobMatch`'s prompt); the duplicate "Matched job
  posts" card on `JobsRolesTab.tsx` is gone (JAMS's Emails sub-tab already showed this); `otherNotes`
  confirmed dead (never reached the AI matcher), removed from the UI, field/column kept. Settings gained a
  compact Automation card (Play/Pause + read-only "sent today"); the full checkbox/progress-bar/editable-
  limit card is deleted from `JamsOverviewTab.tsx` entirely — editable daily limit was NOT preserved
  elsewhere, flagged to the operator, no ask yet to bring it back. Root-caused (not just theorized) a real
  production quota wall while investigating: the platform Gemini key is free-tier, hard-capped at 20
  requests/day for `gemini-3.7-flash` — confirmed via a direct probe returning `RESOURCE_EXHAUSTED`.
  **Operator decision: stay on free tier deliberately until real users exist, then apply for startup
  credits.** Not a bug — do not "fix" this without a fresh ask.
- **2026-08-25 — DONE: JAMS becomes the landing page again; Settings rebuilt as a flat card grid.**
  `DashboardTab.tsx` (a standalone landing tab that existed briefly) is deleted. New `JamsHub.tsx` owns the
  page-level JAMS header + an Overview/Emails/Monitoring sub-tab strip; `JamsOverviewTab.tsx` is "Overview";
  `JamsTab.tsx` (unchanged internally) is "Emails," trimmed of its own outer panel wrapper. `SettingsTab.tsx`
  went through two shapes same day — first a tabbed draft (wrong, per operator correction), then the actual
  flat bordered-card grid: SMTP Accounts, LinkedIn, Email (embeds `EmailConfigTab`), Resume (plain default
  pointer, deliberately no AI controls), Account. **Explicitly deferred, not built**: a "Resume for AI"
  feature (per-field AI-editability toggles on a profile-based resume, AI-tailored per job description) —
  operator: "do not build this right now... add it to the phase after we build the admin portal." Their
  stated roadmap: 1) pricing/credits/API (mostly done), 2) an unresolved second phase (never explicitly
  confirmed — my interpretation is the admin portal, unconfirmed), 3) this Resume-for-AI feature.
- **2026-08-25 — DONE: manual per-user plan overrides (`max_keywords`, `min_fetch_interval_override` on
  `automailsend_app_state`), a deliberately small stepping stone, not real billing** — operator: "this is for
  now... later we will integrate it and turn it into a complete SaaS product." Admin-only, via
  `AdminPortal.tsx`'s new `OverrideCell`; both nullable, `null` = no override = today's behavior unchanged.
- **2026-08-25 — DONE: AI infrastructure hardening (operator's explicit "Phase 1," ahead of an admin
  portal "Phase 2").** Root-caused and fixed two real, previously-silent bugs on first real production
  traffic: `gemini-1.5-flash` had been retired from the API (confirmed via a live `/v1beta/models` probe —
  AI had never actually worked end to end since 2026-08-18 despite shipping), fixed by switching to the
  `gemini-flash-latest` alias; zero rate limiting existed between Gemini calls across three workers sharing
  one process, fixed with a single `throttleGeminiCall()` choke point in `ai.service.js`'s `callAiJson`
  (mirrored in `aiClient.ts`, best-effort there since serverless). Also added: input truncation
  (`truncateForPrompt`, 4000/1000 char caps), 20s timeouts (axios + `AbortController` for `fetch`, which has
  no native timeout). A real Gemini key was provisioned and live-verified (a real AI-personalized email
  confirmed sent, pending→sent in the DB).
- **2026-08-25 — DONE: Quick Send explicit compose modes + per-category resume naming.**
  `QuickSendModal.tsx` gained a `ComposeMode` radio ("write" / "ai" / "template," no more implicit default
  from the role's own send-mode setting) and an always-editable subject field. `resumeNaming.ts` gained
  `resumeSource()` (upload/scratch/profile, derived from existing `Attachment` fields — no new column) +
  `ResumeSourceBadge.tsx` pill on Library rows; the existing name-collision guard now scopes uniqueness
  **per source category**, not globally.

- **2026-08-25** — **"Preview as PDF" page breaks now provably identical to the live editor (third same-day
  follow-up — operator ask: "the page breaks are messed up again... have some inspiration from the normal
  resume builder page preview... present the PDF as it is presenting it in the resume builder, just
  bigger").** Root cause of the mismatch (confirmed by direct DOM measurement, not guessed): the previous
  pass mounted its own independent copy of the template and ran its own `computePageBreaks` pass — correct
  in principle (same function, same technique as ResumeBuilder.tsx's live preview), but `computePageBreaks`
  self-corrects for whatever CSS `zoom` is active on its ancestor at measurement time, and the *live editor's
  small in-form pane* and *this modal's own much-bigger size* land on genuinely different zoom levels — the
  browser's sub-pixel text/glyph snapping doesn't cancel out identically between two different zoom factors,
  even after the scale-correction. Confirmed directly: ~92 of a resume's 97 measured atoms landed 1-4px
  apart between the two contexts, enough compounded drift to tip the total page count from 5 to 4.
  **Fix**: stop re-measuring in the modal entirely — `ResumeBuilder.tsx` now passes its own already-computed
  `pageBreaks` array into `previewPdf`'s snapshot state, and `PdfPreviewModal.tsx` reuses those exact break
  points instead of running `computePageBreaks` a second time. Only one measurement ever happens, so there's
  nothing left to disagree with. Verified live: both surfaces show "Page 1 of 5" (was 4 in the modal, 5 in
  the editor); paged through all 5 pages in the modal, content matches; Download still works (lazy-generates
  the real PDF only when clicked, confirmed a real file downloads and the button resets). Noted, not fixed
  (pre-existing, present identically in the live editor too, not what was asked): page 5 renders visually
  blank — confirmed via direct measurement this is a genuine near-zero-content trailing page (the live
  editor's own translateY offset for page 5 sits at 3664.17px against a 3664px-tall document, i.e. next to
  nothing left to show) rather than a bug in either renderer.

- **2026-08-25** — **"Preview as PDF" reworked to a fully custom, non-interactive renderer (same-day follow-
  up, operator ask — "do not use the default preview provided by the browser... use your own preview...
  only show the resume, not the sidebar... should not be interactive... cover almost the whole height of
  the screen").** The first pass (below) handed the real PDF blob to an `<iframe>`, which brought Chrome's
  own PDF.js chrome along uninvited (thumbnail sidebar, zoom toolbar). Replaced with: `lib/resumePdf.tsx`'s
  render core (renamed `renderResumePdf`) now resolves the finished `blob` *and* the raw ingredients — the
  one continuous source JPEG (`imgDataUrl`) plus each page's `{startPx, endPx}` slice, from the exact same
  single html2canvas capture, no double render. New exported type `ResumePdfPreview` carries all of it plus
  a `downloadUrl` (still a real blob: URL, for the modal's own Download link). `PdfPreviewModal.tsx` now
  draws its own stack of plain `.pdf-preview-page` boxes (`overflow:hidden`, `pointer-events:none`, real A4
  proportions) each holding one absolutely-positioned `<img>` shifted by that page's `startPx` — the same
  shift-and-clip idea `generate()` uses for jsPDF, just via CSS instead of draw calls, so it's still pixel-
  faithful to the real file, not a separate approximation. A `ResizeObserver`-driven fit-to-width `zoom`
  (same pattern as ResumeBuilder.tsx's own live-preview `fitScale`) keeps pages from overflowing a narrower
  modal without ever upscaling past native size. New CSS (`globals.css`): `.pdf-preview-modal` (95vh, much
  taller than the generic `.preview-modal` defaults those were sized for a small image/iframe check, not a
  full document), `.pdf-preview-stack` (the one scrolling element — native scroll, no custom viewer
  chrome), `.pdf-preview-page`. Verified live via Playwright (profile mode only, same reasoning as below):
  no PDF.js chrome, full-height modal, clean multi-page scroll with a natural gap between pages and no
  bleed/duplication at the boundary, zero console errors.

- **2026-08-25** — **"Preview as PDF" added beside Download PDF (operator ask — a pop-up showing "the resume
  as it will look in full A4 size, a completely complete resume").** `lib/resumePdf.tsx`'s `generate()` was
  split into a shared `renderToBlob()` core (the exact same html2canvas+jsPDF pipeline — page breaks, masks,
  everything, unchanged) plus two thin callers: `generate()` (unchanged behavior — uploads and returns an
  Attachment) and new `generatePreviewUrl()`, which skips the upload and just wraps the blob in
  `URL.createObjectURL` — so the preview is pixel-identical to the real download, not an approximation, and
  a candidate clicking Preview repeatedly while tweaking style settings doesn't leave orphaned Library
  files behind. New `components/PdfPreviewModal.tsx` (sibling to `AttachmentPreviewModal.tsx`, same
  `.preview-modal`/`.preview-frame` CSS) shows it in an `<iframe>` with Download/Close actions and Escape-
  to-close; `ResumeBuilder.tsx` builds a `{id:"preview", label, templateId, data}` object from whatever
  `formData`/`formTemplateId` currently is (works identically in both "From your profile" and "Start from
  scratch" modes) and revokes the blob URL on close/unmount. Verified live via Playwright, profile mode
  only (deliberately avoided touching scratch mode this pass — no need to re-exercise that code path right
  after today's data-loss incident): real 4-page PDF rendered correctly in the pop-up, Escape closed it
  cleanly.

- **2026-08-25** — **Save button moved to the top of the resume preview (operator ask — "put the save
  button at the top of the [resume] and alongside the arrow that are shifting the page")**, alongside the
  existing ‹ Page X of Y › nav row. Profile mode's "Save" used to live at the bottom of the editor column
  (`extraControls`), far from the page-nav arrows it now sits beside; scratch mode's own primary action
  ("Use as X's resume") is unaffected — stays in its toolbar, per the earlier "useless button" clarification
  confirming that one wasn't in scope. `renderFormAndPreview` gained a 4th param, `previewHeaderExtra`,
  mirroring the `previewFooterExtra` pattern from the toolbar-cleanup pass below — the top bar now renders
  whenever there's a header extra OR more than one page (previously gated on page count alone).

- **2026-08-25** — **CRITICAL, FIXED: a real race condition in ResumeBuilder.tsx's scratch-mode autosave
  could silently wipe a saved "Start from scratch" resume's content.** Found live — operator reported "where
  did all the content of my profile go?" right after the toolbar cleanup below; investigation (direct
  Supabase reads via the service-role key, bypassing any one browser session's auth state) confirmed real
  loss: the `automailsend_resume_profiles` row backing role "AI Automation"'s scratch resume
  (`ffc905a2-60d3-471e-8aaf-145c36323ff6`, `scratch_resume_profile_id` on `automailsend_role_defs`) had gone
  from 4 experience / 8 projects / 1 education / 8 certifications / 28 skills to completely empty, its
  `updated_at` landing seconds after a page load.
  - **Root cause**: two effects in `ResumeBuilder.tsx` — one syncs `scratchLabel`/`scratchTemplateId`/
    `scratchDraft` from the loaded `scratchProfile` when its id changes, the other debounced-autosaves those
    same three state vars 800ms after they change. Both fire in the same commit whenever `scratchProfile` is
    already resolved on the very render its id first becomes available (not just literal mount — any render
    where a previously-null/different `scratchProfile.id` becomes this one). The sync effect's `setState`
    calls don't apply until the *next* render, so the autosave effect, running immediately after in the same
    pass, still closes over the *stale* pre-load values (`""` / `"modern"` / `emptyResumeData()`) and
    schedules a save of those over the real data 800ms later. A fast cascading re-render usually cancels
    that stale timer in time — not guaranteed, and when it isn't, real data silently gets overwritten with
    blanks.
  - **Fix**: a synchronous ref (`justHydratedScratch`, visible to the autosave effect in the very same
    pass, unlike `setState`) marks "this pass just loaded real data, do not autosave it" every time the sync
    effect runs; the autosave effect checks and consumes it before ever starting a save timer. Verified live
    against the real account, twice: (1) reproduced the original loss independently before the fix, (2)
    after the fix + recovery below, a fresh page load fired the autosave again (confirmed via `updated_at`
    changing) but the content came through fully intact — the harmless "resave identical real data" case,
    not data loss.
  - **Recovery**: two untouched older `automailsend_resume_profiles` rows for the same role (both labeled
    "AI Automation", created 2026-08-19/20, last touched 2026-08-20 — from before a separate, blank
    "(from scratch)" draft became the role's active `scratch_resume_profile_id`) still held the real content
    intact. Operator confirmed restoring from the fuller one (classic template, 8 certifications, 28
    skills — content strongly matching what the 2026-08-24 PDF-generation debug session had rendered);
    restored via direct `data`-column copy (service-role key, `frontend/.env.local`'s anon key not
    sufficient for a cross-row admin-style write) into the live row, preserving its id/label/template so the
    role's own `scratch_resume_profile_id` link didn't need to change. Confirmed by count and by the
    post-fix live reload above.
  - **Follow-up**: `automailsend_candidate_profiles` (the separate "My Profile" master table) was also found
    completely empty for this account during the same investigation — checked page.tsx's own candidate-
    profile autosave for the identical race and it's NOT vulnerable (its load callback sets `profile` state
    and the `lastSavedProfile` comparison ref together, atomically, in one `.then()`, so the "just loaded,
    don't echo it back" case can never mismatch); its `updated_at` (2026-08-19T14:06, before any resume-
    building activity that day) confirmed this was never filled in, not a second incident. Operator asked
    to have it populated anyway (had assumed "My Profile" and the resume were the same data) — copied the
    same restored content in directly (service-role key), mapping `ResumeData.personalInfo`/`summary` onto
    the profile's flat name/email/phone/address/bio/portfolio_url fields and converting `skills: string[]`
    into `ProfileSkill[]` (adding an id per entry) since that's the one shape CandidateProfile doesn't share
    verbatim with ResumeData — everything else (education/experience/projects/certifications/languages) is
    the same item type, reused as-is. Confirmed written: name, email, 4 experience, 8 projects, 1 education,
    8 certifications, 28 skills.

- **2026-08-25** — **Resume Builder toolbar cleanup (operator ask, list of 5, clarified over one
  AskUserQuestion round + a screenshot for the ambiguous "useless button" item).** All five done:
  1. The inline template `<select>` (Modern/Classic) that lived in the "Start from scratch" toolbar, right
     next to Import/Delete — the "useless button" the operator meant (confirmed via screenshot) — is gone.
     Redundant given the Style tab sits one click away in the same view.
  2/5. Template choice now lives in the shared **Style** tab (`StyleSection`) instead, and — new — works for
     **both** modes: "From your profile" never had a template picker before (hardcoded `"modern"`); it now
     has its own per-role `profileTemplateIds` state (same keyed-by-role pattern as `profileResumeNames`),
     threaded into `finalizeProfileResumeSave`'s `generateResumePdf` call.
  3. **Download PDF** moved out of both modes' toolbars to a new action bar directly under the preview's
     page window (`renderFormAndPreview`'s new `previewFooterExtra` param + an always-rendered Download PDF
     button there) — "at the bottom of the resume," not scattered in the editor toolbar.
  4. **Delete** (scratch mode only) moved the same way, via `previewFooterExtra`.
  5. **Import from a resume** (the toolbar one — `handleImport`, not the empty-state's own
     `handleImportFromEmptyState` CTA, left untouched) moved out of the scratch-mode header up to the outer
     top bar, directly left of the role-switcher `<select>` — only rendered when `activeMode === "scratch"
     && scratchProfile` (it has nothing to target otherwise).
  Verified: clean `tsc --noEmit`, clean `eslint` (only the same pre-existing `set-state-in-effect` +
  `catch (e: any)` findings as before, none new), dev server compiles and serves `/resumes` with the
  `ResumeBuilder` chunk intact. Not re-verified interactively in-browser this pass (Playwright MCP was
  disconnected) — worth a click-through next time it's available.

- **2026-08-24** — **The actual generated PDF (not just the live preview) had four real, previously-
  unverified bugs — all fixed, verified with real downloaded PDFs rendered via PyMuPDF, not just reasoning
  or screenshots (fourth same-day follow-up, operator ask: "the pdf is still messed up... make the pdf and
  the resumebuilder perfect this time, don't stop until done").** Context: `lib/resumePdf.tsx`'s actual
  Save-generated PDF was never live-verified after the 2026-08-20 line-level-pagination + four-sided-padding
  rework (that day's data-loss incident interrupted verification before it happened) — only the live preview
  was. All four bugs below were real and independent, found by iterating: generate a real PDF via a live
  `Save` click → download it from Supabase Storage → render pages with PyMuPDF at 150–300dpi → inspect
  pixels directly (screenshots at normal zoom repeatedly looked "fine" at a glance and hid real defects; a
  couple of early high-DPI reads also went the other way — misreading a generous, correct margin as a
  cutoff at a glance — so every finding below was confirmed by measuring, not eyeballing).
  1. **Padding math used the wrong px-per-mm ratio.** `computePageBreaks`'s `paddingPx` param must be in the
     *same px-space* as the container it measures. The live preview's container genuinely is laid out in
     real CSS mm, so `mmToPx()`'s generic 96dpi ratio is correct there — but `resumePdf.tsx`'s off-screen
     render host was a flat, arbitrary `width:"800px"` (chosen only for html2canvas sharpness) with no
     relationship to real mm at all; feeding it a 96dpi-scaled padding silently mixed two different scales,
     making `pageHeightPx` ~17% too generous, so real content ran past the true printable area and off the
     bottom of the page. Fixed by deriving padding from this render's *own* actual mm-per-px ratio instead.
  2. **Render width didn't match the live preview's real content width**, for the same underlying reason —
     text wrapped differently (more words per line at 800px than the true ~180mm-equivalent column would
     allow), so the PDF's effective font size and page count both silently diverged from what the candidate
     designed on screen (confirmed: 3 PDF pages vs. 5 shown live for the same resume). Fixed by rendering at
     `mmToPx(pageWidth - 2×padding)` instead of a flat constant — `html2canvas`'s existing `scale: 2` still
     supersamples this for sharpness, no separate "make the render wider for quality" hack needed.
  3. **File size: ~27MB per PDF** (confirmed: jsPDF *does* dedupe the one shared source image across every
     `addPage()`, so this wasn't accidental triplication — a several-page resume's full-height canvas as
     lossless PNG is just genuinely that large on its own) — comfortably over Gmail's 25MB attachment cap,
     i.e. this app's actual "AI-automated job applications" purpose could silently fail to send. Switched
     `PNG` → `JPEG` at quality 0.92 (a resume is flat white space and crisp text, not photographic detail —
     no visible quality loss at normal or even 300dpi inspection) — combined with fix #2's narrower render,
     cut the same resume to ~1.9MB, a ~14.6x reduction.
  4. **Bleed-through at page seams, both directions, confirmed via 300dpi PyMuPDF renders** — the previous
     page's last line faintly visible at the top of the next page, and (separately, subtler) a trace of the
     next atom peeking through at a page's bottom edge; the underlying cause is that jsPDF has no true
     per-draw clip for the one continuous source image every page is sliced from (`.clip()` was tried as a
     real fix and reverted immediately — with an active clip region, `addImage` stopped painting *anything*
     on the page in this jsPDF version, a worse regression than either masking bug), so the existing
     white-rectangle masks' boundaries don't always land pixel-perfect against where the image actually
     paints, being independently-computed. Fixed with an *asymmetric* guard, not a uniform one — the two
     margins aren't symmetric to protect: the top margin band is always genuinely blank by construction, so
     a small fixed guard extending that mask further down is safe at any reasonable size; the bottom mask's
     boundary is defined by where the last *included* atom itself ends, so naively shrinking it the same way
     reaches directly into that atom's own text — confirmed the hard way (a first 2mm bottom guard visibly
     erased the bottom third of a certification's own line). Real fix: `computePageBreaks` gained an optional
     `safetySlackPx` param (0 unless passed — ResumeBuilder.tsx's live-preview call omits it deliberately, it
     clips with real DOM `overflow:hidden` and never had this failure mode) that reserves a small guaranteed-
     blank slice at the bottom of every "full" page *before* deciding what fits, so a small bottom guard
     smaller than that reservation can never legitimately reach into real content — except on the very last
     page of the whole document, a second edge case found immediately after fixing the first: there's no
     "next atom" there to have been excluded to prove the reservation did anything, so the same guard
     re-created the identical bug one atom later (on the resume's actual final line). Fixed by skipping the
     bottom guard specifically on the last page, where it's also simply unneeded — nothing follows in the
     source image to ever bleed up into it.
  - Clean `tsc --noEmit`; lint diff showed the same 1 pre-existing error (an unrelated pre-existing
    `useEffect(() => setMounted(true), [])` pattern) before and after, nothing new. All four fixes verified
    together on one final real Save: 4 pages, every page's top and bottom individually inspected at 300dpi —
    clean margins throughout, zero bleed, all 8 certifications present and complete (two of the bugs above
    had been silently dropping/corrupting the last one or two), file size ~1.9MB, zero console errors.

- **2026-08-24** — **Resume Builder: sticky Content/Style tabs, role selector always a real dropdown, preview
  width rebalanced, defensive fallbacks against a page cutoff (third same-day follow-up).** Operator feedback
  on the second follow-up's own screenshot, three concrete asks plus one bug report:
  - **Content/Style tabs now `position: sticky; top: 0`** inside the editor pane (was plain in-flow, so it
    scrolled away with the header the moment you scrolled past Personal Info) — "same as the other options
    like from your profile," which stay visible by being outside the scroll region entirely; sticky was the
    simpler fix for something that needs to stay *inside* this pane's own scroll context. Needs an opaque
    `var(--bg)` background so content scrolling underneath doesn't show through.
  - **Role selector is now always a real `<select>`**, styled with `className="btn ghost"` to match the
    tabs beside it — reverses the previous pass's "collapses to plain static text with only one role" (which
    itself came from an explicit `AskUserQuestion` answer): "AI Automation is not a title, it's like a
    drop-down... it should be visible, same as the other buttons." Operator feedback after seeing it live
    superseded the earlier answer.
  - **Right preview column's flex changed `"1 1 480px"` → `"0 1 480px"`** (no grow) — it was growing equally
    with the editor column, but the page's fixed A4 aspect ratio means extra *width* past what its available
    *height* already limits it to is unusable, so on wide viewports that excess just sat empty beside the
    page ("a lot of space on the right side... not being used," operator report) instead of going to the
    editor column, which can always use more room. All leftover space now flows to the editor only.
  - **Page-cutoff bug ("being cut from the bottom, I am unable to scroll it") not reproduced locally**
    despite testing 1366×768, 1440×900, and 1920×1040 — all fit correctly with visible margins. Shipped
    three defensive fixes regardless, cheap and harmless if the sizing math was already right: (a)
    `previewViewportRef`'s `overflow: hidden` → `overflowY: auto` (a no-op when fitScale is correct, since
    nothing overflows; if it's ever wrong, the page becomes reachable by scrolling instead of silently
    clipped with no way out — directly answers "unable to scroll it" regardless of root cause); (b) an extra
    `requestAnimationFrame`-delayed recompute pass after mount, guarding against the page window ever
    measuring 0 on the very first synchronous call (would otherwise strand `fitScale` at its default of 1 —
    full native, un-shrunk size — until an unrelated resize happened to fire the `ResizeObserver`); (c) an
    explicit `window.resize` listener alongside the `ResizeObserver` as a redundant safety net. Best guess if
    it recurs: the operator's tab had been open across many hot-reloads while this whole pass was being
    built — worth a hard refresh first if seen again, and getting the exact window size at repro time would
    help pin it down for real, since it wasn't viewport-size-dependent in any size tried here.
  - Clean `tsc --noEmit`; lint diff-checked against the same 5 pre-existing errors as the prior pass (0 new).
    Verified live via Playwright at 1440×900: sticky behavior confirmed by scrolling the editor pane deep
    into Experience entries with Content/Style still pinned at the top; role dropdown renders with visible
    border/chevron; right column visibly narrower, no dead space; zero console errors throughout.

- **2026-08-24** — **Resume Builder: tab-row consolidation + Content/Style split + page no longer touches
  the pane edges (UI pass, second same-day follow-up).** Operator feedback after the scroll-bug fix below:
  the tab chrome (old "Builder"/"Library" row + a separate role-tabs row + a separate mode-pills row = three
  stacked rows) ate too much height, and the Style sliders belonged on their own tab, not inline with every
  content section. Confirmed via `AskUserQuestion` which of two readings of the ask was correct ("Library"
  as the third top-level tab vs. a new "Elaborate" AI tab) — operator picked Library. Changes, all in
  `ResumeBuilder.tsx` (`resumeSubTab`/`formTab` state, both new) and `page.tsx`:
  - **Three stacked rows → one.** "Builder"/"Library" + the role-tabs row + the "From your profile"/"Start
    from scratch" pills collapsed into a single flat row: `[From your profile] [Start from scratch]
    [Library]` on the left (still `.btn primary/ghost`, same visual language as the old pills), a role
    picker on the right — a `<select>` when `roleDefs.length > 1`, plain static text when there's only one
    (today's real state), matching "if I have multiple roles I select from a dropdown; right now it's only
    one so it's presented as a heading." `resumeSubTab` (was `page.tsx` state) and `ResumeConfigTab`'s render
    both moved into `ResumeBuilder.tsx` itself, since Library is now just this row's third tab rather than a
    sibling component `page.tsx` had to switch between — `page.tsx`'s Resumes-tab block is now just the
    heading plus one `<ResumeBuilder>` call, no local sub-tab state left.
  - **Content vs Style**, new nested tabs inside the editor column (`formTab`) — PersonalInfo through
    Languages under "Content", the `StyleSection` sliders alone under "Style"; Save/Download stay visible
    under both (moved out from being the last thing in a single long scroll). Scroll-sync's `[data-atom-key]`
    walk simply finds nothing while Style is open (no preview page corresponds to it anyway) — no special-
    casing needed.
  - **Page no longer touches the pane's edges** — the `fitScale` `ResizeObserver` callback now fits the page
    into `viewport.clientHeight - 24` instead of the full height, so the existing flex-centering splits that
    24px slack into a real ~28px gap on both top and bottom (confirmed via DOM measurement) instead of the
    page landing flush with the pane.
  - `ResumeConfigTab.tsx`'s two user-facing strings that said "on the Builder tab" updated to name the new
    tabs directly. Clean `tsc --noEmit`; lint diff-checked against a `git stash` baseline — same 9
    pre-existing errors/8 warnings before and after (all `catch (e: any)` and `setState`-in-effect patterns
    already present, none introduced by this pass). Verified live via Playwright: all three top-level tabs,
    both Content/Style tabs, and the single-role static-text case (no dropdown for one role) all screenshot-
    confirmed; role-dropdown-with-2+-roles path type-checks but wasn't visually exercised (no second role on
    the test account to click through).

- **2026-08-24** — **Resume Builder: whole document was scrollable, not just the editor pane ("the page is
  not scrolling / in the middle it's suspended").** Root cause: `layout.tsx`'s global `<footer>` (the
  marketing-page copyright/disclaimer bar) is a permanent sibling of `{children}` inside `<body
  class="flex flex-col min-h-screen">`, on *every* route including the logged-in app shell. `.app-container`
  itself is correctly a fixed `height:100vh; overflow:hidden` shell with only its own internal panes meant to
  scroll (see the 2026-08-20 viewport-layout entry below) — but the footer still rendered below it, pushing
  body's total content to ~1031px against a 900px viewport, and since nothing set `overflow-y:hidden` on
  html/body, the whole *document* became scrollable on top of the intended internal scrolling. Practical
  effect: scrolling anywhere outside the two intentionally-scrollable panes (sidebar, role-tabs row, the
  resume preview column) scrolled the entire app shell instead of doing nothing — sliding the header/sidebar
  top off-screen and revealing the footer underneath, which is what read as "stuck partway / suspended."
  Fixed with one scoped rule in `globals.css`: `body:has(.app-container) footer { display: none; }` — hides
  the footer only while the app shell is mounted (confirmed marketing pages like `/login` are untouched,
  footer still `display:block` there). Verified live via Playwright: body `scrollHeight` now exactly equals
  viewport height (was 1031px vs 900px before), `canBodyScroll` false, and scrolling the editor pane 3500px
  moves only that pane (`window.scrollY` stays 0 throughout) while the preview's page-sync still correctly
  advances (Page 1 of 4 → Page 2 of 4) as the scroll crosses into page-2 content. No plan file — one-line CSS
  fix once root-caused.

- **2026-08-20** — **Resume Builder: line-level page-break granularity + real four-sided padding (fifth
  same-day follow-up, reverses part of the third follow-up below).** Operator explicitly reversed the earlier
  "never split a section across pages" rule: "it's better to break just the line... if the line is getting on
  the edge of the page, just take that line to the next page." Also: page padding must be genuine on all four
  sides (top/bottom, not just left/right), in the actual generated PDF too, not just the live preview.
  Implementation: `lib/markdownLite.tsx`'s `renderMarkdownLite` gained an optional `atomKeyPrefix` param
  tagging each bullet/paragraph line as its own `data-page-atom`; new `renderPlainLines()` export does the
  same for non-markdown text (Summary). Both templates (`ModernTemplate.tsx`/`ClassicTemplate.tsx`) split
  each entry into a heading atom (own `data-atom-key={id}`, unchanged — editor scroll-sync depends on this
  exact key) plus per-line description atoms, so a long entry now spills only its overflow lines to the next
  page instead of dragging the whole entry along. Four-sided padding: `lib/resumePdf.tsx` reworked to draw
  with zero baked-in CSS padding and compute `y = pagePaddingMm - startPx*mmPerDomPx` per page plus explicit
  white `pdf.rect()` masks for both the top-bleed and bottom-tail regions on *every* page (previously only
  the very first/last page effectively got a margin, since a mid-document page break is just a Y-offset into
  one continuous source image, not a real page boundary). Clean `tsc --noEmit` at the time. **Live
  re-verification of this specific change was interrupted by the data-loss incident directly below and only
  happened today (2026-08-24, see above) as a side effect of the scroll-bug investigation** — confirmed
  working correctly then (page-sync advances cleanly at line granularity, no console errors).

- **2026-08-20** — **Incident: candidate's real profile data wiped from Supabase mid-session; fully
  recovered and written back live.** Discovered mid-verification of the follow-up above (a profile fetch
  401'd after a dev-server restart; a reload cleared the console error but the underlying DB row itself was
  genuinely empty, confirmed via direct authenticated REST query, not a client-rendering bug). Best-guess
  cause (not fully proven): the restart-triggered auth hiccup raced a debounced profile autosave, which fired
  with local state still the empty result of the failed load and silently overwrote the real row. Recovery,
  at the operator's explicit direction ("put everything in the portal yourself, I don't want to copy and
  paste myself"), combined: (a) transcribing content from this session's own earlier screenshots, (b)
  discovering and downloading a still-extant older master resume PDF from Supabase Storage (deleting/
  overwriting a DB row's JSON array doesn't delete the underlying storage objects it pointed to) that filled
  the remaining gaps, and (c) `automailsend_role_defs`' `selected_*_ids` arrays surviving the wipe intact,
  enabling exact-original-UUID reuse for experience/education/projects/certifications (zero guesswork).
  Written back via direct authenticated Supabase REST PATCH calls (session's own `access_token` +
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`, respecting RLS as the real user). Verified live: My Profile, Resume
  Builder (all fields, all pages), and Library all confirmed correct with zero console errors; the junk
  auto-generated PDF from the empty-state period was replaced by a correctly-regenerated one via the existing
  zero-click auto-generate mechanism (clearing `role_defs.resume_id` re-triggers it). Three residual loose
  ends, all minor/cosmetic, flagged to the operator: an orphaned junk PDF blob still sits in Supabase Storage
  (delete attempt was blocked by the permission classifier, not yet retried); 3 of the original 28 selected
  skill names were unrecoverable (no per-skill atom key existed in the templates to map ID→name) and were
  dropped, the role now selects the 25 that were recovered; contact email and two certification issuers had
  live-app-vs-recovered-PDF discrepancies, resolved in favor of the live app's own values. Full reconstruction
  notes (incl. the discrepancies) live in the session scratchpad's `profile-reconstruction.md`, not in-repo.

- **2026-08-20** — **Resume Builder: preview too small + page breaks still wrong (fourth same-day
  follow-up).** Reported after the third follow-up shipped: "the resume is too small and the page break is
  also not right." Two real bugs found and fixed, both verified live via Playwright (DOM-position
  measurements, not just screenshots — screenshots at this zoom were too ambiguous to trust alone):
  - **Preview too small**: `lib/resumePaginate.ts`'s `pageHeightPx` was computed as `contentWidth *
    A4_ASPECT` — content width already excludes the page's own left/right padding, so running it through
    the *outer* page's aspect ratio (and never subtracting top/bottom padding at all) under-counted how
    much fits per page, inflating page count (6 pages for content that only needs 5). Fixed by
    reconstructing the true outer width (content width + 2×padding) before applying the aspect ratio, then
    subtracting 2×padding — `computePageBreaks` now takes an explicit `paddingPx` param (see its header
    comment) and a new `mmToPx()` export converts `pagePaddingMm` for both callers. Separately, the
    `renderFormAndPreview` header content (hint text, resume name field, scratch-mode toolbar) moved from
    fixed chrome *above* the two-pane split into the scrollable editor column itself (a new `header` param),
    reclaiming real height for the preview since it's no longer reserved for both columns unconditionally —
    confirmed live: available preview height went 558px → 659px (+18%) at a fixed 900px test viewport, more
    at realistic 1080px+ viewports.
  - **Page breaks still wrong — a real duplication bug, not cosmetic**: found by DOM-measuring exact
    positions rather than trusting screenshots. `.resume-print-area` had padding on the *same* element doing
    the `overflow:hidden` clipping + `translateY` sliding — CSS padding doesn't clip an overflowing sibling,
    it only reserves space for content that fits within it, so the tail of the *previous* page's content
    (whatever fell in the last paddingMm) kept bleeding into and repainting over the current page's supposed
    blank top margin (confirmed: two bullets from one entry visibly duplicated at the top of the next page).
    Fixed by moving padding into fixed spacer divs *outside* the clipped/sliding region (top spacer → new
    `.resume-print-clip` div with left/right padding + overflow:hidden → bottom spacer), so nothing can ever
    render into them regardless of scroll position. **Second, subtler instance of the same root cause**:
    the clip window was a *constant* full-page height, but `computePageBreaks` can legitimately end a page
    short of that (next atom didn't fit in the remainder) — the constant-height clip then showed the start
    of the *next* page's content early in that leftover space, duplicating with what the next page also
    showed from that same break point. Fixed by sizing the clip to `pageBreaks[currentPage] -
    pageBreaks[currentPage-1]` (this page's actual content span) each render, not a constant. Verified by
    stepping through all 5 pages checking exact first/last visible line per page — no duplication, no gaps,
    every page a clean atom-boundary continuation of the last.
  - **`lib/resumePdf.tsx`'s actual PDF-generation path got the equivalent fixes** — a new unpadded
    `contentRef` (nested inside the padded `hostRef`, mirroring the live preview's split) so
    `computePageBreaks` gets the same padding-aware math; a plain white `pdf.rect(...,'F')` mask over any
    page's unused tail (jsPDF has no per-draw clip, so this achieves the same "no early peek" result as the
    live preview's variable-height clip window). Verified end-to-end with a real Save (not just reasoning
    about the math) — temporary test entry generated with zero console errors, confirmed in the Library,
    then deleted to restore the operator's real account to its clean prior state.
  - Clean `tsc --noEmit`; lint clean of new issues (only the same pre-existing idioms as before). No plan
    file for this pass — small enough, and each bug was found by live DOM measurement mid-investigation
    rather than being knowable upfront.

- **2026-08-20** — **Resume Builder: fixed one-page viewport, scroll-synced pages, typography controls
  (third same-day follow-up).** Full plan at the time in `C:\Users\msamr\.claude\plans\woolly-discovering-
  candle.md`. Three connected fixes/features, all validated live via Playwright against the running dev
  server (a Plan subagent also empirically repro'd the root bug in a browser before implementation, rather
  than relying on reasoning alone — caught that my first proposed fix, CSS `zoom` instead of `transform`,
  was itself wrong):
  - **Root cause of "pages not breaking apart" found and fixed.** `lib/resumePaginate.ts`'s
    `computePageBreaks` measured atoms via `getBoundingClientRect()` (deliberate, to reflect the live
    preview's scale transform) but then those already-scaled values got reused as literal
    `top`/`translateY` *inside the same scaled subtree* — `top`/`translateY` are always interpreted in an
    element's own **local** (pre-transform) space, so an already-shrunk offset got shrunk again at paint
    time. Verified empirically (500px native → 410px measured post-0.82-scale → 336px when reapplied, a
    real ~18% compounding error). Fixed by making `computePageBreaks` self-correcting: divides every
    returned value by `containerRect.width / containerEl.offsetWidth` (offsetWidth ignores transform *and*
    zoom identically, confirmed empirically) so it always returns native-space px, safe to reapply directly
    regardless of what's active on the ancestor chain. `resumePdf.tsx`'s untransformed off-screen host is
    an unaffected no-op (scale always 1 there).
  - **Layout rebuilt to match the operator's spec exactly**: "the resume page should always be visible in
    front of me... one page should be visible at a time... I should be only able to scroll the content on
    the left side." Replaced the dashed-marker-on-one-tall-scrolling-image preview with a real "page
    window" — `.resume-print-area` is now a fixed real-world-sized (210mm×297mm) `overflow:hidden` box;
    the full (all-pages) rendered content shifts via `translateY` to reveal only the current page. A
    `ResizeObserver`-driven `fitScale`, applied via CSS `zoom` (not `transform` — zoom shrinks the
    element's own layout footprint too, so the surrounding flex box sizes correctly with no extra
    placeholder-box math), shrinks the fixed-size window to fit whatever space is available. A pure-CSS
    flexbox height chain (`page.tsx`'s `.board` → Resumes-tab wrapper → `ResumeBuilder`'s root → the
    two-pane row, `flex:1`/`minHeight:0` at every link) gives the editor column a bounded box to scroll
    within and the preview column a bounded box to fit into, instead of `.main-content` scrolling the whole
    builder view as one piece. `flexWrap:"wrap"` → `"nowrap"` on the two-pane row removes the
    stacking-on-narrow-width trigger that was compounding the sidebar-collapse complaint.
  - **Scroll-linked page auto-sync**: "if I am scrolling... it will automatically shift to the next page."
    Editor-side blocks (each Experience/Project/Education/Certification entry, plus PersonalInfo/Summary/
    Skills/Languages via a new `FormSection` `atomKey` prop) get `data-atom-key`, matching the same stable
    keys the preview templates' atoms already use. `computePageBreaks` now also returns `atomPage: Record
    <string, number>` (which page each key landed on). The editor's own scroll handler (rAF-throttled
    plain scroll-position polling, not `IntersectionObserver` — simpler for a small bounded element set,
    no `rootMargin` tuning) finds the topmost atom past a ~28%-down trigger line and switches the preview's
    page to match. Manual prev/next still works — the next scroll event just re-syncs afterward.
  - **Typography controls**: new `ResumeData.style` field (`ResumeStyleSettings` — font family, size,
    line-height, letter-spacing, page padding), threading through profile/scratch drafts and PDF generation
    "for free" since it's just another `ResumeData` field. Every hardcoded `Npt` in both templates converted
    to an em multiple of the root font-size (proportional scaling); letter-spacing composes via a
    `--rf-tracking` custom property rather than overriding the two templates' own deliberate heading
    tracking. New `StyleSection` (sliders + a font-family select) in the editor column.
  - **Print path needed three resets, not the pre-existing one** (`window.print()`'s `@media print`, a
    third, separate rendering path from both the live preview and `resumePdf.tsx`'s actual PDF generation)
    — `.resume-print-area`'s `zoom:1!important`, its `overflow:visible!important`/`height:auto!important`
    (undoing the fixed one-page window), and a new `.resume-print-content` class on `previewContentRef` to
    reset its `translateY`. All three confirmed via Playwright's print-media emulation.
  - **Verified live** (not just build/lint): preview shows exactly one full page, never scrolls;
    scroll-sync confirmed switching pages correctly (60% editor scroll → jumped from page 1 to page 4 of
    5); manual prev/next confirmed; all four typography controls confirmed changing the live preview
    (including pagination correctly recomputing, 5→8 pages, when bigger text pushed content further);
    sidebar collapse/expand confirmed correctly rescaling the preview (rendered width changed appropriately
    with available space); Save (the real `resumePdf.tsx` PDF-generation path) confirmed still producing a
    correctly-named attachment with zero console errors; print-media resets confirmed via emulation. Clean
    `tsc --noEmit`, clean `npm run build`, lint clean of new issues.

- **2026-08-20** — **Resume Builder crash fix + zero-click default + always-append saves + unique names +
  filename-sanitization bug (second same-day follow-up).** Found via real browser testing (Playwright),
  not just build/lint — the previous same-day pass had never actually been click-tested:
  - **Crash: "Maximum update depth exceeded," Builder unusable in the default view.**
    `ResumeBuilder.tsx`'s `profileDraft` called `composeResumeData(...)` inline as a fallback every render
    (until the first edit seeded `profileDrafts`) — a new object each time. That fed `formData`, which the
    pagination `useLayoutEffect` depends on, so every render re-triggered it → `setPageBreaks` → re-render →
    new `profileDraft` object → effect again → infinite loop, the instant Builder opened in "profile" mode
    (the default). Fixed by memoizing `profileDraft` with `useMemo`, plus a defensive equality guard in
    `measure()` so an unrelated re-render never causes a spurious state update either.
  - **Bug: bullets still showed as a literal "-".** Root cause wasn't the renderer (fixed earlier same day)
    — real content (especially AI-imported resume text) has no space after the marker, e.g.
    `"-Led a team…"` not `"- Led a team…"`. `markdownLite.tsx`'s regex required `\s+`; relaxed to `\s*`.
  - **Bug: `Attachment.name` was silently slug-sanitized.** `lib/resumePdf.tsx`'s filename derivation ran
    the label through `.replace(/[^a-z0-9]+/gi, "-")` — turned "Muhammad Sohaib Amin — AI Automation" into
    "muhammad-sohaib-amin-ai-automation.pdf" everywhere it's shown/emailed, defeating the whole naming
    feature. Pointless: `uploadAttachment()` already writes to a fully randomized storage path, never
    `file.name` — no storage-safety reason existed to mangle it. Now only strips genuinely unsafe path
    characters and avoids double-appending ".pdf".
  - **Zero-click default resume** (operator ask — "should always be in our library but we do not have to
    manually save it"): the moment a role is opened in Builder's "profile" mode and nothing resolves for it
    at all (`lib/emailResolve.ts`'s `resolveRoleResume` returns null — no override, no candidate-wide
    fallback either), it's silently composed and saved right then, same as clicking Save with zero edits.
    Chosen trigger (confirmed with operator over an alternative "on every Profile save"): PDF generation
    only happens in-browser (html2canvas), so a role never opened in Builder still has nothing, same as
    before.
  - **Saves never overwrite the Library anymore** (operator ask — "then it will create another instance,
    the resume in the library will stay as it is"): `finalizeProfileResumeSave` gained an
    `alwaysNewInstance` param — `true` for the "Save to Profile & Role" sync path (real edits were made, so
    the previous entry stays exactly as it was) and for "Just this resume" (unchanged, already append-only);
    `false` only for "no edits, just re-click Save" (still fine to regenerate the same entry in place, since
    there's nothing new to preserve as a separate version).
  - **Names must be unique, and collisions block rather than silently rename** (operator ask, confirmed
    over an auto-suffix alternative — "block and ask me to rename"). New `lib/resumeNaming.ts`
    (`isNameTaken`/`uniqueNameFallback`, the latter only for the one no-UI path: the zero-click auto-default
    above). Enforced at every path that sets a resume's name: Builder's Save/Sync/"Use as scratch resume",
    and `ResumeConfigTab.tsx`'s upload + inline rename — all show an inline error and refuse to proceed
    rather than silently applying.
  - **Verified live in a real browser this time** (Playwright) — the previous same-day pass's "verified"
    claims (build/lint/manual-trace only) had missed the crash entirely. Confirmed: Builder opens with zero
    console errors; bullets render as "•" against real AI-imported content; a genuine name collision shows
    the inline error and is blocked (no toast, no new file); a non-colliding save produces exactly the typed
    name, spaces and em-dashes intact, in the Library. Clean `tsc --noEmit`, clean `npm run build`, lint
    clean of new issues (only pre-existing idioms remain). **Not verified**: the zero-click auto-default
    path specifically — the test account already had a working global default, so `resolveRoleResume` never
    returned null during testing; that path is logic-reviewed and type-checked but not exercised live
    (deliberately avoided forcing it by clearing the operator's real default resume just to test).

- **2026-08-20** — **Resume Builder/Library cleanup: real pagination, working bullets, naming, simpler
  Library (same-day follow-up).** A dense operator message covering two real bugs and several
  simplifications:
  - **Bug: bullets could vanish in generated PDFs.** `lib/markdownLite.tsx`'s bullets used a native
    `<ul><li>` (browser-drawn disc marker) — `html2canvas` (behind every generated/emailed PDF, see
    `lib/resumePdf.tsx`) is unreliable about painting native list markers. Fixed by rendering an explicit
    "•" character in its own span instead — identical everywhere (live DOM, native "Download PDF" print,
    html2canvas snapshot).
  - **Bug: pagination was blind.** The live preview was one endless div (no page boundaries at all), and
    `useResumeProfilePdf`'s PDF generation sliced the flattened `html2canvas` image at *fixed pixel
    offsets* — could cut an experience entry in half even though the templates' `breakInside: "avoid"`
    styling implied otherwise (that CSS only affects native print, never consulted by raster slicing).
    New `lib/resumePaginate.ts`'s `computePageBreaks(containerEl)` measures every `[data-page-atom="true"]`
    element (added to the existing `breakInside:"avoid"` wrapper divs in
    `ModernTemplate.tsx`/`ClassicTemplate.tsx` — one per entry, one per simple section) and only ever
    breaks at one of their bottom edges — shared by both `lib/resumePdf.tsx` (real pagination in the
    emailed attachment) and `ResumeBuilder.tsx`'s live preview (dashed page-boundary markers + a
    "Page X of N ‹ ›" control that scrolls to each boundary — the "page clickers"). Every measurement in
    `computePageBreaks` goes through `getBoundingClientRect()` uniformly (not mixed with
    `offsetWidth`/`scrollHeight`) specifically because the live preview sits inside a `transform:
    scale(0.82)` ancestor, which only `getBoundingClientRect()` reflects — a real bug caught during
    implementation, not in the original plan.
  - **Builder: "Upload your own" mode dropped.** Confirmed with operator: uploading now only ever sets the
    one candidate-wide default (in the Library) — no more per-role upload override. Two pills left:
    "From your profile" / "Start from scratch". `RoleDef.resumeMode`'s `"upload"` literal stays on the
    type/schema (never drop data) but the UI folds any legacy value into the "profile" pill via
    `effectiveMode()`. No resolver change needed — `resolveRoleResume`'s existing override→global-default
    fallback already does the right thing.
  - **Naming.** New "Resume name" field on the "profile" mode toolbar — defaults to `"{candidate name} —
    {role label}"` instead of a bare role label like "Automation" — since `Attachment.name` is literally
    nodemailer's `filename` (confirmed in both workers), this is what recipients see. Also editable via
    inline rename in the Library list. **"Just this resume" now prompts for a name** (confirmed with
    operator): `SyncResumeModal.tsx` reveals a name input under that choice; the result is a **new,
    separately named Library entry that does not replace the role's active resume** —
    `finalizeProfileResumeSave` gained a `keepAsDefault` param (`true` = regenerate/replace in place as
    before, `false` = always append, never touch `RoleDef.resumeId`).
  - **Library simplified.** Removed: the "Generate from Resume Builder…" dropdown (a resume you build now
    always goes through Builder's own Save/"Use as resume" flow, which already lands it here) and the
    "🔄 Regenerate" button ("I don't know what the 'degeneration' button means"). Each list row is now the
    resume itself: an inline-editable name, and a radio marking the one candidate-wide default — replacing
    the standalone "Your default resume" card entirely.
  - **Import from a resume**: kept, given a real second entry point — the scratch mode's empty state now
    offers "+ Start a resume" and "✨ Import from an existing resume" as two equally-weighted options
    (previously import was a small toolbar button only visible after a blank draft already existed).
  - **Verified**: clean `frontend` build (first try); lint clean of new issues (only pre-existing idioms —
    `catch (e: any)`, the mount-effect pattern, page.tsx's unrelated pre-existing warnings); manual trace of
    `computePageBreaks` against synthetic multi-entry cases (confirmed: normal multi-page split lands on
    atom boundaries, a single oversized atom forces a best-effort break, an atomless/empty resume falls
    back to blind slicing rather than no pagination); dev server restart, clean 200s on `/resumes`,
    `/roles`, `/templates`, `/`. **Not verified**: no real browser click-through of the paginated preview,
    rename, or default-radio controls; no live PDF/email round-trip (no Gemini key or SMTP send exercised
    this session either way) to visually confirm the bullet/pagination fixes against a real attachment.

- **2026-08-20** — **Resumes tab's "Configuration" sub-tab renamed "Library" (same-day follow-up).**
  Operator: once per-role resume authoring moved to Builder, Configuration only ever did one thing — the
  resume/file pool + picking a default — so "Library" names it, "Configuration" didn't. `page.tsx`'s
  `resumeSubTab` type literal renamed `"configuration"` → `"library"` (button text + all render/state
  checks); `ResumeConfigTab.tsx`'s panel headings reframed ("Your Files" → "Your Resume Library",
  "Global default resume" → "Your default resume"). Component/file name unchanged (`ResumeConfigTab.tsx`
  stays — "rename the label, not the file," same precedent as `JobsRolesTab.tsx`).
  - **Also fixed while in the area**: several other components (`RoleTemplates.tsx`, `EmailConfigTab.tsx`,
    `ProfileTab.tsx`, `JobsRolesTab.tsx`) had stale hint text pointing candidates to "the Resumes tab's
    Configuration sub-tab" for a role's resume — stale since the *previous* Resume Builder redesign already
    moved per-role resume authoring to Builder, an oversight from that pass. All now correctly point to
    Builder (per-role resume) or Library (file pool/default), whichever is accurate.
  - **Verified**: clean `frontend` build; lint shows only pre-existing patterns outside the touched
    lines (text/comment-only changes, no logic touched); dev server restart, clean 200s on `/resumes`,
    `/roles`, `/templates`, `/`.

- **2026-08-20** — **"Additional files" removed; sidebar made collapsible.** Two small, unrelated operator
  asks in one turn.
  - **Additional files gone**: a role's send now attaches its resume only — the extra-files-alongside-the-
    resume feature (`RoleDef.selectedFileIds`, its checklist UI on `ResumeBuilder.tsx`) is removed.
    `resolveRoleAttachments` (`lib/emailResolve.js`/`.ts`) simplified to `{resume, all}` (`all` = `[resume]`
    or `[]`, `resolveRoleAdditionalFiles` deleted); both workers' `role_defs` selects drop
    `selected_file_ids`. Column/type field **kept, unread** (same "superseded, never dropped" precedent as
    every other retired field here) — no migration, nothing to drop. Verified via a direct-call test
    against the real backend resolver: a role with `selected_file_ids` still set only ever attaches its
    resume now.
  - **Sidebar collapsible**: new `sidebarCollapsed` state in `page.tsx`, persisted to `localStorage` (a
    display preference, not app data — same "default on server, correct client-side in an effect" pattern
    `activeTab` already uses, since `localStorage` isn't available during SSR). A `.sidebar-toggle` button
    (a flex sibling between `<aside>` and `<main>`, not inside the sidebar itself, so it stays clickable
    regardless of collapse state) collapses `.sidebar`'s width to 0 rather than an icon-only rail — the
    nav has no icon set today, so a full collapse was the lower-risk choice.
  - **Verified**: clean `frontend` build; backend `node --check` on touched files; lint shows only
    pre-existing patterns well outside the touched lines (not new); dev server restart, clean 200s on
    `/resumes`, `/roles`, `/templates`, `/`. **Not verified**: no real browser click-through of the
    collapse toggle.

- **2026-08-20** — **Resume Builder redesign: role-tabbed, three modes, "from profile" mode syncs back to
  Profile/Roles (same-day follow-up to the two entries below).** Operator: the Builder tab was "full of
  shit" — a flat profiles dropdown + scattered toolbar buttons, no per-role structure. New: role tabs (same
  as everywhere else), and for the active role exactly three pills —
  - **"From your profile"** (default) — composed live from `composeResumeData(profile, roleDef)`, editable
    right there, ephemeral until Save (kept in a `Record<roleId, ResumeData>` in component state — survives
    switching role tabs, lost on leaving the page since nothing's written to the DB until Save). Save
    diffs the draft against a freshly-recomputed baseline (`lib/resumeSync.ts`'s
    `diffResumeAgainstProfile`) and, if anything's new/changed, asks via a new `SyncResumeModal.tsx`:
    **"Save to Profile & Role"** (`mergeResumeIntoProfile` — appends new items, overwrites edited existing
    ones by id, new skill names become new `ProfileSkill`s, summary → `bio`, identity fields sync if
    changed — **never deletes/removes anything**, even an item the draft dropped) or **"Just this
    resume"** (skip the merge). Either way, renders + uploads via the existing `useResumeProfilePdf`,
    tagged `Attachment.sourceRoleId`, replacing this role's previous profile-sourced attachment in place
    (not duplicating) — same underlying call as the removed `handleBuildResumeFromProfile`.
  - **"Start from scratch"** — today's ordinary blank builder, zero profile linkage, ever. Scoped to a role
    via new `RoleDef.scratchResumeProfileId` (so reopening the pill resumes the same draft) instead of a
    flat list. The AI "✨ Import from a resume" action moved here (was a toolbar button before).
  - **"Upload your own"** — unchanged Phase-E override path (`RoleDef.resumeId` set directly), moved here
    from Resumes → Configuration.
  - **Consolidation**: `ResumeConfigTab.tsx`'s per-role section (picker + last-turn's build/refresh block)
    is gone — Configuration now holds only "Your Files" + the candidate-level "Global default resume"
    picker. All per-role resume authoring lives on Builder now, one place only.
  - New `RoleDef.resumeMode: "profile"|"scratch"|"upload"` (default `"profile"`) + `scratchResumeProfileId`
    — both pure authoring/UI state, **never read by send-time resolution**
    (`resolveRoleResume`/`resolveRoleAttachments` untouched, no backend change at all this pass).
  - **Known edge case, accepted by design**: "renaming" a skill in the profile-mode draft (remove old chip,
    add new) and syncing adds the new name alongside the old rather than replacing it — the "never delete
    shared data" rule means the old skill has to be removed manually on My Profile/Roles afterward.
    Similarly, blanking an identity field (e.g. clearing Phone) and syncing does NOT clear it on the shared
    profile — an empty draft value always falls back to the existing profile value, never blanks it.
  - **Still deferred, unchanged**: AI-generated tailored resume per application.
  - Schema: two new columns on `automailsend_role_defs` (`resume_mode` text default 'profile',
    `scratch_resume_profile_id` uuid FK to `automailsend_resume_profiles`, on delete set null). No changes
    to `automailsend_resume_profiles` itself — `JobBoardTab`'s Easy Apply/`ApplyModal` still depend on it
    staying a flat, freely-labeled list, confirmed by reading that file before designing this.
  - **Verified**: migration applied + verified live; clean `frontend` build; lint shows only pre-existing
    idioms repeated (`catch (e: any)`, the `useEffect(() => setMounted(true), [])` portal-mount pattern
    also used in `AddProfileItemModal.tsx`/`resumePdf.tsx`, the state-sync-on-selected-id-change effect
    pattern the original `ResumeBuilder.tsx` already used) — nothing new; manual trace of
    `diffResumeAgainstProfile`/`mergeResumeIntoProfile` against ~7 concrete cases (no changes, new item,
    edited item, removed item, skill rename, identity edit, identity blank) since there's no ts-node/tsx
    runtime for direct-call testing of frontend TS; dev server restart, clean 200s on `/resumes`, `/roles`,
    `/templates`, `/`. **Not verified**: no real browser click-through of the three pills or the sync modal.

- **2026-08-20** — **Resume default source: build from profile, upload demoted to override (same-day
  follow-up to the hierarchy below).** Operator: a role already hand-picks its own profile subset
  (`RoleDef.selected*Ids`, set on Roles), so a resume filtered to exactly that subset should be the
  *default* way a role gets its resume — no upload/Builder round-trip required. "Cut out all other data" =
  the built resume must contain only what's selected for that role, never the whole profile.
  - No schema change, no backend change — reuses Phase E's hierarchy as-is
    (`globalResumeId`/`resumeId`/`resolveRoleAttachments` untouched). Only *how* `RoleDef.resumeId` gets set
    changed.
  - New `ResumeConfigTab.tsx` handler `handleBuildResumeFromProfile()`: `composeResumeData(profile, active)`
    (already existed — `lib/resumeCompose.ts`, filters the profile to the role's selected ids) →
    `useResumeProfilePdf().generate(...)` (already existed — `lib/resumePdf.tsx`) → tag the resulting
    `Attachment` with new `sourceRoleId` (parallel to the existing `sourceResumeProfileId`) → `resumeId`.
    Refreshing (when the role's current resume already carries its own `sourceRoleId`) replaces that pool
    entry in place instead of piling up duplicates.
  - UI: per-role section in `ResumeConfigTab.tsx` now shows "Build my resume from profile" /
    "🔄 Refresh from profile" first, with the existing upload/pick-a-file picker demoted below it as
    "Or use your own file". Existing roles with an already-set override are unaffected.
  - **Still deferred**: AI-generated tailored resume per application, and Resume Builder improvements —
    same as Phase E's own deferral, unchanged.
  - **Verified**: clean `frontend` build; lint shows only the file's existing `catch (e: any)` pattern
    (not new); dev server restart, clean 200s on `/resumes`, `/roles`, `/templates`, `/`. **Not verified**:
    no real browser click-through of the new build/refresh buttons.

- **2026-08-20** — **Resume hierarchy: one resume per role, with a candidate-level global default.**
  Operator: "how many times can you possibly build one resume for one role?" — the flat `selectedFileIds`
  subset (section 29) didn't distinguish a resume from a portfolio file, and a role could have any number
  of resume-shaped files at once. New: `CandidateProfile.globalResumeId` (the hierarchy's top) +
  `RoleDef.resumeId` (a role's own override; null = inherit global) — both plain nullable text pointers
  into the existing `files` pool, no new storage mechanism, same tolerant "unknown id → nothing" resolution
  as everywhere else. `selectedFileIds` narrows to "additional files" (portfolio etc.) alongside that one
  resume; a role's own resume id is excluded from its additional-files checklist in the UI, and the
  resolver de-dupes by id as a safety net regardless.
  - Backend `lib/emailResolve.js`/frontend `lib/emailResolve.ts` rewritten:
    `resolveRoleResume`/`resolveRoleAdditionalFiles`/`resolveRoleAttachments` (returns `{resume,
    additionalFiles, all}` — `all` is what actually attaches). Old `resolveRoleFiles` removed; both
    workers + `QuickSendModal.tsx` switched to `resolveRoleAttachments(...).all`. Both workers' selects
    extended (`resume_id` on role_defs, `global_resume_id` on candidate_profiles).
  - `ResumeConfigTab.tsx` rebuilt: added a "Global default resume" picker (single `<select>` from the
    pool) and rebuilt the per-role section — a "Resume for {role}" `<select>` (first option "Use global
    default", then every pool file as an override) with its own "+ Upload new resume"/"Generate from
    Resume Builder" quick actions (set `resumeId` directly, not `selectedFileIds`), then the existing
    additional-files checkbox list, now excluding the role's resume file from its options.
  - **Explicitly deferred, not built**: AI-generated tailored resume per application ("AI Assist" resume,
    a 3rd source alongside upload/Builder), and improving the Resume Builder itself — operator raised both
    as ideas/context but said to work on the one-resume-per-role piece first. Revisit when asked.
  - Schema: two new nullable `text` columns (`candidate_profiles.global_resume_id`,
    `role_defs.resume_id`), no FK (ids point into a jsonb array). Non-breaking — existing data gets `null`
    on both, no regression to what's already attached (still resolved via `selectedFileIds` as "additional
    files" until the operator explicitly designates a resume).
  - **Verified**: migration applied + verified live; 11 direct-call assertions against the real
    `emailResolve.js` (role override beats global, falls back to global, both unset → none, stale ids on
    either → none not a crash, null roleDef/profile don't crash, additional files resolve independently,
    combined list is resume-first + de-duped); clean `frontend` build; lint clean (nothing new); backend
    `node --check` + `require()` load; dev server restart, clean 200s on `/resumes`, `/roles`,
    `/templates`, `/`. **Not verified**: no real browser click-through of the new pickers.

- **2026-08-20** — **Email Templates tab split into Templates/Configuration sub-tabs; "let AI write it"
  restored (3rd send mode again).** Operator ask: Templates (wording) + Configuration (send mode) as two
  sub-tabs, and the three modes should include "let us write the whole email" — the mode dropped on
  2026-08-19 is back. This is a straight policy reversal of that day's "kept simple, just two modes" call;
  nothing from that removal needed undoing at the data layer since `generateAiPersonalizedEmail` was
  deliberately left exported/working "in case the operator wants it back" — that bet paid off.
  1. `EmailSendMode` is `"manual" | "ai-select" | "ai-write"` again; `EMAIL_SEND_MODES` has all three.
  2. New `EmailConfigTab.tsx` — the "Configuration" sub-tab: role-tab bar (shared `activeTemplateRole`) +
     the mode radios (moved verbatim out of `RoleTemplates.tsx`, which now only owns template wording).
     `page.tsx`'s `templates` tab renders a `btn primary`/`btn ghost` switcher (`templatesSubTab`, not
     persisted, opens on Templates) above `RoleTemplates`/`EmailConfigTab`, mirroring the Resumes tab's
     Builder/Configuration split from earlier the same day. `RoleTemplates.tsx` lost its own outer
     `.panel`/`.panel-head` — that now lives once in `page.tsx`, wrapping both sub-tabs.
  3. Backend: `ai.service.js`'s `buildUserMessage`/`generateAiPersonalizedEmail` — `baseTemplate` optional
     again (null → an explicit "None — write in your own words" block in the prompt, not a crash).
     `automail.worker.js`/`batchSend.worker.js` — both regained the `ai-write` branch: no template
     resolved, straight to `generateAiPersonalizedEmail(user.candidate_info, recipient, context_text,
     null, profile, temperature)`; handles the model's `{skip:true,reason}` shape (job post wasn't
     relevant) same as before; spends 1 AI credit; skips the recipient with a clear log line if AI is
     off/out of credits rather than sending something broken. `batchSend.worker.js` also had a real
     pre-existing bug fixed while in there: it early-returned the *whole batch* if the templates table was
     empty, which would incorrectly block an all-ai-write account with zero templates — now only skips
     per-recipient when a manual/ai-select role has nothing.
  4. `JamsTab.tsx`'s pre-bulk-send template-existence check regained its `mode !== "ai-write"` exemption.
     `QuickSendModal.tsx`'s hint text (Quick Send has no scraped job post, so ai-write can't run there
     either) now covers ai-write the same way it already covered ai-select — falls back to the role's
     template deterministically.
  5. Schema: **no migration** — `role_defs.email_send_mode` was always a plain `text` column, no CHECK
     constraint restricting values.
  - **Verified**: clean `frontend` build; lint re-checked (nothing new); backend `node --check` + a
    `require()` load of both workers and `ai.service.js` with `.env` present; confirmed
    `generateAiPersonalizedEmail(..., null, ...)` no longer throws synchronously on the null baseTemplate
    (fails only at the expected "no GEMINI_API_KEY locally" point, same standing caveat as every AI path
    this session); dev server restart, clean 200s on `/templates`, `/roles`, `/emails`, `/`. **Not
    verified**: no real Gemini key, so the actual ai-write generation call itself is untested live; no
    browser click-through of the new Templates/Configuration sub-tabs.

- **2026-08-20** — **Roles tab module checklist: accordion + Skills moved into the same pop-up as everything
  else.** Pure UI polish on `JobsRolesTab.tsx`'s "Modules for this role" block, no data model changes.
  1. The five checklists (Experience/Education/Projects/Certifications/Skills) are now an **accordion** —
     `ModuleChecklist` takes controlled `expanded`/`onToggleExpand` props instead of its own `useState`;
     `JobsRolesTab` holds one `expandedModule: ModuleKey | null` and opening a section auto-collapses
     whichever else was open (click the open one again to close it fully).
  2. **Skills** lost its separate always-visible inline text-input+Add-button row — it now works exactly
     like the other four: "+ Add skill" opens `AddProfileItemModal`. The modal gained a `"skills"`
     `AddableSection` (comma-separated input, so "React, Node.js" still adds two at once) and an
     `existingSkillNames` prop for case-insensitive dedup against the profile (only that section needs it).
     `onAdd`'s type widened to accept `ProfileSkill[]` alongside the single-item types the other sections
     pass, since skills can add several at once.
  - **Verified**: clean `npm run build`; lint re-checked (only pre-existing set-state-in-effect warnings —
    nothing new); dev server restart, clean 200s on `/roles`, `/profile`, `/`. **Not verified**: no real
    browser click-through of the accordion or the new Skills pop-up.

- **2026-08-20** — **Resume/file UI consolidated onto the Resumes tab (Builder + Configuration sub-tabs).**
  Operator: "keep everything related to the resume in the resume tab." Pure UI relocation — the underlying
  hierarchy from the 2026-08-19 follow-up (one shared `CandidateProfile.files` pool, each role picks its
  own subset via `RoleDef.selectedFileIds`) is unchanged; no schema/type changes this round.
  1. New `ResumeConfigTab.tsx` — the "Configuration" sub-tab. Two sections: **Your Files** (upload / generate
     from a saved Resume Builder profile / preview / regenerate / delete — moved verbatim from
     `ProfileTab.tsx`) and **Which files apply to each role** (a lightweight role-tab bar reusing
     `activeTemplateRole` — the same shared role state as Roles/Email Templates — + a plain checkbox list
     w/ select-all/none against the active role's `selectedFileIds`, replacing the old `ModuleChecklist`
     "Files" entry that lived on `JobsRolesTab.tsx`). Uploading/generating here still auto-selects the new
     file for whichever role tab is active, same convenience the old Roles-tab quick-add had.
  2. `page.tsx`'s `resumes` tab now renders a small `btn primary`/`btn ghost` sub-tab switcher (`resumeSubTab`
     local state, not persisted — always opens on Builder) above either `ResumeBuilder` (unchanged) or the
     new `ResumeConfigTab`.
  3. `ProfileTab.tsx` lost its Files `FormSection` and the `userId`/`resumeProfiles` props that only existed
     for it (now unused) — a hint paragraph points to Resumes → Configuration instead.
  4. `JobsRolesTab.tsx` lost the "Files" `ModuleChecklist` + quick-add block and the `userId`/`resumeProfiles`
     props that only existed for it — same "remove the now-dead prop, don't leave it stubbed" precedent as
     `ResumeBuilder.tsx`'s `userId` removal on 2026-08-19. `SelectionField` union dropped `"selectedFileIds"`.
  5. `RoleTemplates.tsx`'s hint copy/comments updated to point at Resumes → Configuration instead of the old
     Roles-tab Files checklist.
  - **Verified**: clean `npm run build` (first try); lint re-checked (only pre-existing `catch (e: any)`
    pattern in the new file, matching the rest of the codebase, and pre-existing set-state-in-effect
    warnings — nothing new); dev server killed/`.next` cleared/restarted, all 7 routes (`/`, `/profile`,
    `/roles`, `/resumes`, `/templates`, `/emails`, `/board`) returned clean 200s with no error-level log
    lines. **Not verified**: no real browser click-through of the new Builder/Configuration sub-tabs.

- **2026-08-19** — **Email Templates follow-up: attachments moved to role-level, "ai-write" dropped.**
  Operator feedback right after the Email Templates redesign below shipped:
  1. Attachments (resume + files) are a **role-level module selection** now, not per-template/global-
     checkbox — `RoleDef.selectedFileIds` picks from `CandidateProfile.files` (one unified pool, resume
     included as just another file), same pattern as `selectedExperienceIds` etc. Operator: "global"
     means shared storage reusable across roles, never "the same file for every role" — each role's
     selection is what applies to jobs matched to that role.
  2. `CandidateProfile` gained a "Files" section on **My Profile** (`ProfileTab.tsx`) — upload directly or
     generate from a saved Resume Builder profile (tagged via `Attachment.sourceResumeProfileId` for
     regenerate). `JobsRolesTab.tsx` gained a 6th checklist ("Files") + inline quick-add.
  3. `ResumesTab.tsx` **deleted** (absorbed into `ProfileTab`'s Files section) — "Resumes" sidebar tab is
     now just the Builder, no more sub-tabs. `RoleTemplates.tsx` lost all attachment UI — a template is
     purely label/subject/content again.
  4. "Let AI write my mail" (the template-free 3rd send mode) **dropped** — back to two: manual, "let AI
     choose." Both workers' ai-write branches removed; `chooseTemplateForJob` (ai-select) unaffected.
  5. Schema: one new column (`role_defs.selected_file_ids`); `candidate_profiles.global_files` repurposed
     (not renamed) as the unified pool; the per-template resume_*/use_global_* columns added an hour
     earlier are already superseded, left unused.
  - **Verified**: migration live; direct-call tests of the real `resolveRoleFiles`/`describeFiles`; clean
    build; lint clean (no new issues); dev server clean across all touched routes. **Not verified**: no
    real browser click-through of the new Files UI (Profile or Roles tab) or a generated PDF's output.

- **2026-08-19** — **Email Templates redesign: randomization removed, 3 send modes, per-template/global
  resume+attachments.** (Superseded same day by the follow-up above — attachments moved off templates
  entirely to role-level, and the 3rd send mode was dropped. Kept below for history.) Operator ask: kill the template/resume randomization mechanism entirely, replace
  with an explicit per-role choice — manual (pick one template), AI picks among your own unedited
  templates (cheap, no hallucination — AI only classifies, never writes), or AI writes the whole email
  with no template at all. Attachments move off a separate per-role resume library onto each template
  itself, plus one global default any template can opt into.
  - `RoleDef.emailSendMode` ("manual"/"ai-select"/"ai-write") + `selectedTemplateId` — mode lives on the
    role (owns the template pool, is what a job matches against), not a template.
  - New `chooseTemplateForJob` (ai.service.js) for ai-select — classification only, templates never
    rewritten. `generateAiPersonalizedEmail`'s `baseTemplate` param is now optional (null for ai-write).
  - `RoleTemplate` gained `resumeSource`/`resumeFile`/`resumeProfileId`/`resumeProfileSnapshot`/
    `useGlobalResume`/`useGlobalFiles`. New `lib/resumePdf.tsx`'s `useResumeProfilePdf()` hook (shared,
    off-screen html2canvas+jsPDF render) turns a saved Resume Builder profile into an attachable PDF.
  - **`ResumesTab.tsx` repurposed**, not deleted — was the per-role randomized resume-file library, is now
    the "Global Resume & Files" panel on `CandidateProfile` (`global_resume_*`/`global_files`).
    `ResumeBuilder.tsx`'s old "Save to Resume Library" button/flow is gone (superseded by the new picker).
  - `pickFromPool`/`templatePicker.ts`/`.js` **deleted** (no consumers left) — replaced by
    `lib/emailResolve.ts`/`.js`'s `resolveAttachments`/`describeResumeSource` (frontend/backend mirror
    pair, same "keep in sync" convention as crypto.ts/js). `automail.worker.js`/`batchSend.worker.js`
    rewired to resolve mode/template/attachments per recipient via `role_defs` instead of random pool
    selection. `JamsTab.tsx` bulk-send dropped its AI/Template mode picker (now per-role, not per-send).
  - Old randomized columns/table (`is_default`/`in_randomizer`, `automailsend_resumes`) left in place,
    unused — same "superseded, never dropped" precedent as every other retired column in this schema.
    `JobBoardTab.tsx`'s Apply-flow resume-file picker still legitimately reads `automailsend_resumes` (a
    separate, untouched consumer) — kept wired on purpose, only its write path (old ResumesTab UI) is gone.
  - **Verified**: migration applied+verified live (13 new columns/3 tables); direct-call tests of the real
    `resolveAttachments`/`describeResumeSource` (not a mirror — plain JS) across the resume/global/ai-write
    matrix, plus a mirror of `chooseTemplateForJob`'s response-validation branches; clean `frontend` build;
    backend `node --check` + `require()` load of every touched module; lint checked (one genuinely new
    issue, an unused `useMemo` import, fixed); dev server clean across `/templates`, `/resumes`, `/roles`,
    `/emails`, `/`. **Not verified**: no real Gemini key (chooseTemplateForJob/ai-write untested live, same
    standing caveat as every AI feature this session); no real browser click-through of the new
    per-template resume picker, Global Resume & Files panel, or a generated PDF's actual visual output.

- **2026-08-19** — **My Profile follow-up #2: comma-split skills, quick-add from Roles, select all/none.**
  Operator confirmed My Profile "works very smoothly" and debounced auto-save is working as intended, then
  asked for three things:
  1. Skills input now splits on commas — "React, Node.js, PostgreSQL" adds three skills. Both
     `ProfileTab.tsx`'s adder and `ResumeBuilder.tsx`'s `SkillsSection` (the plain-resume version) do this.
  2. New `components/AddProfileItemModal.tsx` — floating "+ Add" popup for experience/education/project/
     certification, opened from the Roles tab's checklists, same fields as `ResumeBuilder.tsx`'s section
     editors. Writes into the *exact same* `CandidateProfile` state `ProfileTab` edits (new
     `onProfileChange` prop on `JobsRolesTab`, wired to the same `setProfile` — single source of truth,
     satisfies the operator's "synchronization across the platform" ask by construction rather than
     needing separate sync logic) and auto-selects the new item for the currently-open role. Skills get an
     inline add input instead (operator asked, then self-corrected — "do we have skills? okay my bad" —
     landed on a lighter inline field rather than a modal for one text input).
  3. Select all / Select none on every module checklist.
  - **Verified**: clean `frontend` build, direct-call tests of comma-split/dedup and select-all/none logic,
    dev server restart clean. **Not verified**: no real click-through in an actual browser session.

- **2026-08-19** — **My Profile follow-up: separate tabs again + markdown-lite descriptions.** Two
  operator refinements right after the "Profile as knowledge base" phase below shipped:
  1. Profile and Roles reverted to two separate sidebar tabs (`'profile'`/`'roles'` in `TAB_NAMES`) — the
     merged-section-with-internal-toggle from the phase below was undone same day for easier navigation.
     No data/prop changes, purely `page.tsx` tab wiring.
  2. Experience/project descriptions and education notes are now one markdown-lite text block each
     (`- `/`* ` for bullets, `**bold**`) instead of the old bullets-as-separate-inputs editor. Type change:
     `ResumeExperience.bullets: string[]` → `description: string`; `ResumeProject` dropped its separate
     `bullets` array into its existing `description`; `ResumeEducation.notes` kept its name, gained the
     rich editor. New `lib/markdownLite.tsx` (`renderMarkdownLite`, used by both resume templates) + new
     `components/HoverHint.tsx` (pure-CSS hover popover — deliberately not `HelpTooltip`'s click-modal,
     since the operator specifically asked for hover) + `ResumeBuilder.tsx`'s new `MarkdownLiteField`
     (reused by `ProfileTab.tsx` automatically, same as every other section editor).
  - **Found and fixed while implementing** (same pattern as last phase's app_state.candidate_* catch):
    `aiClient.ts`'s resume-import AI prompt and `serializeResumeForAts()` both still referenced the old
    `bullets` array — updated both, or PDF resume import and AI-ATS scoring would have silently lost all
    experience/project content the moment this shipped.
  - **Verified**: clean `frontend` build, direct-call tests of the markdown-lite grouping/parsing logic
    (bullet grouping, mixed prose+bullets, blank lines, inline bold — all passed), dev server restart
    clean across `/profile`, `/roles`, `/`, `/board`, `/resumes`. **Not verified**: no real
    experience/project entry has been written with the new syntax and eyeballed in the actual PDF export.

- **2026-08-19** — **Profile as knowledge base + per-role module selection + Easy Apply.** Operator's own
  strategic framing: most candidates target one role (a slight chance of a few), so profile = permanent
  (identity, bio, every experience/education/project/certification/skill), role = thin/disposable (search
  criteria + which profile items apply). Plan-mode build, one `AskUserQuestion` (Easy Apply behavior —
  chose "compose then review", never auto-submit silently).
  - New `automailsend_candidate_profiles` table (mirrors `automailsend_recruiter_profiles`) replaces the
    old 5-field `CandidateProfile`. `RoleDef` gained `availability` + `selected*Ids` (5 arrays) — new roles
    default to **everything selected** (the forgiving default). New pure `lib/resumeCompose.ts`
    (`composeResumeData`, `matchRoleToPosting` — no AI call, keyword-overlap only).
  - **Found and fixed a real breakage risk while implementing**: `automail.worker.js`/`batchSend.worker.js`
    and `/api/jobs/apply` all read the OLD `app_state.candidate_*` columns directly for `{{candidate_*}}`
    placeholders/application snapshots — moving `CandidateProfile` off those columns without updating these
    three consumers would have silently blanked every automated send and new application's contact info
    the moment this shipped. All three now read `automailsend_candidate_profiles` instead. This was not in
    the original plan's file list — surfaced mid-implementation, fixed rather than shipped broken.
  - Profile + Jobs & Roles merged into one sidebar section ("Profile & Roles", Profile/Roles sub-tabs,
    same pattern as Resumes' Files/Builder split). `ProfileTab.tsx` reuses `ResumeBuilder.tsx`'s
    Experience/Education/Projects/Certifications/Languages section editors verbatim (now exported) — same
    controlled `data`/`onChange` shape, not worth duplicating; Skills is the one bespoke id-aware editor.
    `JobsRolesTab.tsx` gained `availability` + five collapsible "Modules for this role" checklists.
  - Resume Builder gained "New from role" (compose from a role's modules). Job Board gained "⚡ Easy
    Apply" next to manual Apply — composes into a real `ResumeProfile` (labeled `"<Role> — Easy Apply"`,
    reused in place on repeat clicks), opens the existing `ApplyModal` pre-selected on it. No API route
    changes needed — `/api/jobs/apply` already accepted a `resumeProfileId`.
  - **Simplified from plan, flagged not hidden**: profile edits don't retroactively backfill new items into
    already-configured roles' selections — only role *creation* defaults to everything. Revisit if the
    operator wants that later.
  - **Verified**: migration applied+confirmed live, direct-call tests of `composeResumeData`/
    `matchRoleToPosting` (subset filtering, stale-id tolerance, keyword scoring, fallbacks — all passed),
    clean `frontend` build, `node --check` on both edited backend workers, dev server restart clean across
    `/`, `/profile`, `/board`, `/login`, `/signup`. **Not verified**: no real profile has been filled in and
    walked through Easy Apply end-to-end against a real posting.
  - **Open item, still deferred**: the Job-Board auto-apply automation proposal from the prior entry below
    is now even more directly enabled by this phase (module selection + composeResumeData are exactly what
    that proposal would reuse) — still not built, still waiting on the operator's direction, especially for
    the recruiter-side automation question.

- **2026-08-19** — **Closed a blank-slate gap: Templates/Resumes could orphan-create under a phantom role.**
  Operator re-confirmed the "no preloaded roles, candidate adds their own on Jobs & Roles" requirement
  (already shipped 2026-08-18) and described the full flow they expect end-to-end. Audit found the rest of
  the app already honors it (AutoFetch requires a role with keywords, Automail requires a template, no
  default `RoleDef` rows anywhere) — **except** `RoleTemplates.tsx`/`ResumesTab.tsx`: `activeTemplateRole`
  defaults to the literal placeholder `"fullstack"` and is never restored from the DB
  (`active_template_role` is write-only in `storage.ts`'s `loadState()` — a separate, older, low-impact
  bug left as-is), and unlike Jobs & Roles' own `active = roleDefs.find(...) || roleDefs[0]` fallback,
  these two tabs used `activeTemplateRole` raw — so a candidate who opened Templates/Resumes before ever
  visiting Jobs & Roles could hit "+ New" and save a template/resume under a role key that was never
  actually added. Fixed: `page.tsx` now has an effect that repoints `activeTemplateRole` at
  `roleDefs[0].key` once real roles load and the current value doesn't match any of them; both tabs also
  gained their own `roleDefs.length === 0` empty state ("add one on Jobs & Roles first"), mirroring
  `JobsRolesTab.tsx`'s existing empty state. **Verified**: clean `frontend` `npm run build`. **Not a schema
  change.**
- **2026-08-19** — **Recruiter portal follow-up: signup-locked account type + company-email gate.**
  Operator feedback right after Tier 4 shipped, overriding that phase's original "self-serve, any account
  can flip on recruiter mode" design:
  1. Signup now asks Candidate vs. Recruiter (`signup/page.tsx`) — **one email is locked to one account
     type for good**, no in-app way to add the other later. Removed the "Become a Recruiter" button from
     `RecruiterTab.tsx`'s null-profile state; it now just explains the account is a candidate account.
  2. Recruiter signup requires a company email — new `lib/companyEmail.ts`'s `isCompanyEmail()` rejects
     the well-known free/personal providers (Gmail, Yahoo, Outlook, iCloud, etc.), checked before
     `signUp()` is even called. Client-side only, same trust level as the rest of this app.
  3. Chosen type is stored in `auth.signUp()`'s `options.data.account_type` (session `user_metadata`), then
     reconciled into a real `automailsend_recruiter_profiles` row on **first login**, not immediately after
     signup — sidesteps the email-confirmation timing issue (no authenticated session exists yet right
     after `signUp()` resolves if confirmation is required, so an RLS-gated insert there would fail).
     Idempotent — only creates the row if one doesn't already exist.
  4. `page.tsx` auto-redirects a recruiter to `/recruiter` on their very first bare-root load, so they
     don't land on the candidate JAMS view.
  **No schema change** — `automailsend_recruiter_profiles`'s existence-signals-capability mechanism from
  Tier 4 is unchanged, just *when* and *how* that row gets created.
  **Verified**: direct-call test of `isCompanyEmail` (case-insensitivity, malformed input, known
  domains), clean `frontend` `npm run build`, dev server restart with a clean log across `/signup`,
  `/login`, `/`, `/recruiter`. **Not verified**: no real signup (candidate or recruiter) has actually been
  clicked through — the email-confirmation-timing assumption behind the first-login reconciliation is
  reasoned through, not click-tested against this project's actual Supabase Auth confirmation setting.
  **Open item, explicitly deferred, not built**: operator asked for a Job-Board auto-apply proposal (reuse
  the automail background-worker methodology — poll open postings, AI-score against the candidate's role
  criteria, auto-submit via the same snapshot/credit-gated pattern as `/api/jobs/apply`) plus a
  recruiter-side automation angle (auto-shortlist by AI-ATS score threshold? auto-outreach to shortlisted
  candidates? — genuinely undefined, needs the operator to pick a direction) — presented as a discussion
  in chat, deliberately not written to a file/artifact (see [[no-online-artifacts-for-design]]-style
  standing preference for this project). Revisit once the operator responds.

- **2026-08-19** — **Tier 4 completed: recruiter portal + AI-assisted ATS.** Operator said "move next"
  after the reply-monitoring report. Confirmed via `AskUserQuestion`: build the recruiter portal (not the
  other bundled Tier 4 idea, multi-platform scraping), postings go live immediately with **no admin
  approval queue** (self-serve, matches this app's existing model — `is_blocked` can still shut a bad
  actor down account-wide). Fully greenfield before this phase.
  - **Recruiter is a capability, not a separate account type** — self-serve "Become a Recruiter" inserts a
    row into new `automailsend_recruiter_profiles`; that row's existence is what `RecruiterTab.tsx`
    checks. One person can be both a candidate and a recruiter on the same login. Sidebar entry is
    **always visible** (unlike the env-gated Admin tab) so the feature stays discoverable — the component
    itself shows an activation CTA when there's no profile yet, the full dashboard once there is.
  - **First cross-user-visible table in the whole schema**: new `automailsend_job_postings` — any
    authenticated user can see an `open` posting, not just its own recruiter (every table before this was
    strictly `auth.uid() = user_id`). Its insert policy is also the first place `is_blocked` gates a
    direct client-side write rather than just a background worker.
  - New `automailsend_job_applications` — candidate sees own, recruiter sees only applications to their
    own postings (RLS subquery against `job_postings.recruiter_id`). No `insert` RLS policy at all — every
    insert goes through new `/api/jobs/apply` (service-role key, `Authorization: Bearer` auth via the
    existing `getAuthedUserId()`), same reasoning as `/api/ai-enhance`/`/api/resume-import`: AI-credit
    spend must be server-verified, and contact-info/resume snapshots should come from trusted DB reads.
  - Resume attached to an application is a **snapshot** (`resume_data jsonb` from the Resume Builder
    and/or `resume_file_url`/`resume_file_name` from the file library), not a live FK — same reasoning as
    `sent_log`'s `template_label`/`resume_label`.
  - AI-ATS only scores structured `resume_data`, never an uploaded PDF — new `serializeResumeForAts()` in
    `aiClient.ts` reduces `ResumeData` to prompt text. A file-only application stays unscored
    (`ai_analyzed_at` null, "unknown isn't a fail" — same as `match_score`); a recruiter can trigger
    scoring later per-applicant via a new "Score with AI" button (`ApplicantsModal.tsx` →
    `/api/jobs/score-application`).
  - **Own AI credit pool**: `automailsend_recruiter_profiles.ats_ai_enabled`/`ats_ai_credits`, deliberately
    separate from candidate-side `AiConfig`/`ai_credits` — new `checkAtsAiGate`/`spendAtsAiCredit` in
    `aiClient.ts`, admin-granted via `AdminPortal.tsx`'s `CreditsCell` (now takes a `field` prop to drive
    both `ai_credits` and `ats_ai_credits` columns) and `/api/admin/users`, which now merges in
    `ats_ai_credits` from the separate table (`null` = not a recruiter, distinct from "0 credits").
  - **No backend/worker changes** — the whole feature lives in the Next.js app (two new API routes + RLS);
    the auto-deploying BullMQ/scheduler backend is untouched, zero deploy risk to existing automation.
  - New frontend: `JobBoardTab.tsx` (candidate-facing browse+apply), `RecruiterTab.tsx` (posting CRUD +
    AI-ATS settings, mirrors `ResumesTab.tsx`'s list+detail pattern and `AITab.tsx`'s settings-form
    pattern), `ApplicantsModal.tsx` (per-posting applicant review). New `'board'`/`'recruiter'` sidebar
    tabs in `page.tsx`.
  - **Verified**: migration applied + confirmed live (three tables, all RLS policies, the
    `unique(job_id, candidate_id)` constraint, and the `is_blocked` subquery all checked directly against
    `information_schema`/`pg_constraint`/`pg_policies`), a direct-call test of the resume-to-text
    serialization (empty/full/skills-only/malformed shapes, no crashes), clean `frontend` `npm run build`
    (both new API routes registered), dev server restart with a clean log across `/`, `/board`,
    `/recruiter`, `/admin`. **Not verified**: no two real accounts exist to walk through post → apply →
    auto-score end-to-end, and still no real Gemini key in place — same standing caveat as every
    AI-dependent phase this session. This closes the full 4-tier roadmap from the operator's original
    strategic ask; next steps are the operator's own (try it, or pick a fresh direction).

- **2026-08-19** — **Tier 3 completed: reply monitoring (IMAP-polling inbound replies into JAMS).**
  Operator said "go-ahead" after the AI tab report, moving to the next roadmap tier. This was the item
  explicitly deferred at JAMS's original build — genuinely greenfield, zero prior reply/IMAP/thread code
  anywhere in the repo.
  - **Per-account opt-in** — a new "Enable reply monitoring" checkbox on each `SmtpConfigPanel` account
    (hidden for SendGrid/Resend, which have no real inbox). Reuses that account's existing `app_password`
    for IMAP too — no new secret to collect.
  - New `backend/src/workers/replyPoll.worker.js` (+ `backend/src/lib/imapPool.js`), driven by a new
    `setInterval` block in `scheduler.js` (`REPLY_POLL_INTERVAL_SEC`, default 300s) — same direct-call,
    Redis-bypassing convention as automail/batch-send, not the (confirmed dead) BullMQ queue path.
  - **Matching**: header match first (`In-Reply-To`/`References` against a `message_id` now captured from
    nodemailer's `sendMail()` result at send time, new `automailsend_sent_log.message_id` column), then a
    sender+subject fallback for clients that mangle threading headers. No match at all → not stored;
    `automailsend_replies` only ever holds attributable replies, never the whole inbox. Every row records
    `match_method` for transparency.
  - Schema: new `automailsend_replies` table (`unique(user_id, message_id)`, select-only RLS — only the
    backend service-role key writes it); `automailsend_smtp_accounts` +`imap_enabled`/`imap_host`/
    `imap_port`/`imap_last_polled_at`; `automailsend_recipients` +`has_replied`/`replied_at`/`reply_count`.
    Applied live, verified (columns, unique constraint, RLS policy all confirmed via direct queries), both
    `supabase_setup.sql` copies mirrored.
  - Frontend: `JamsTab.tsx` shows a "↩ Replied" badge + the contact's actual reply thread inside the same
    expandable history section as sent-email history. New `ReplyRecord` type + `replies` on
    `PersistedState`, kept live via a new realtime subscription in `page.tsx`.
  - **Fixed in passing**: `page.tsx`'s `automailsend_recipients` realtime UPDATE handler was rebuilding
    the recipient row from a narrow field subset — silently *dropping* `match_score`/`context_text`/etc.
    on every realtime update, not just failing to add new ones. Found while wiring in the reply badge
    (which would've kept vanishing on the next unrelated recipient update); now maps the full `Recipient`
    shape.
  - **Dependency/security note**: added `imapflow` + `mailparser`. `mailparser`'s transitive
    `html-to-text`→`deepmerge-ts` chain had a stack-exhaustion DoS advisory on attacker-controlled
    recursive input — relevant since this worker parses genuinely untrusted inbound email. Fixed via a
    `backend/package.json` `overrides` entry pinning `deepmerge-ts@^8.0.1` (patched) rather than
    downgrading `mailparser`; `npm audit --omit=dev` now clean.
  - **Verified**: migration applied + confirmed live, a direct-call test of the pure matching logic
    (header/References/sender+subject fallback/both no-match cases — all passed), `node --check` +
    `require()` load test on every touched/new backend file, clean `frontend` build, dev server restart
    with a clean log. **Not verified**: no real IMAP-enabled mailbox has been polled and no real reply has
    ever been sent to a Cuneihire outreach email — same standing "can't click-test without real
    credentials" caveat as every AI-phase entry below.

- **2026-08-18** — **Tier 2 completed: a dedicated AI tab (temperature + match strictness).** Operator said
  "move to the next tier" after the platform-AI/credits phase — this closes the remaining, previously
  explicitly-deferred half of the original AI ask ("a separate tab for AI... individual page").
  - New sidebar tab `AITab.tsx` (between Resumes and Settings): Enable AI Personalization, read-only
    credits, and two new real knobs — **Temperature** (0–1, default 0.4, threaded into every Gemini call's
    `generationConfig.temperature`) and **Job-Match Strictness** (0–100, default 0/off).
  - Match strictness is a genuinely new, separate, server-persisted gate — NOT the same thing as
    `JobsRolesTab.tsx`'s pre-existing `localStorage` strictness slider, which is untouched (stays a
    personal display filter). The new one actually skips recipients: `automail.worker.js`'s
    fully-automated loop only — a recipient whose scored post is below threshold gets skipped entirely
    (no template/AI/send/credit), before any work happens. Deliberately NOT applied to `batchSend.worker.js`
    (JAMS manual/bulk sends — those are explicit operator choices, shouldn't be silently blocked).
  - `AutomailConfig.aiEnabled` moved into a new `AiConfig` type (`enabled`/`temperature`/`matchStrictness`)
    — decoupled from "Automail" naming. `AutomailModal.tsx` lost its whole AI Personalization section,
    now purely background-sending mechanics again. Fixed the stale "Templates & AI" sidebar label → plain
    "Templates" while in the area (that tab never rendered anything AI-related).
  - Fixed two small pre-existing bugs found while touching `JamsTab.tsx`'s AI-gated buttons ("Send Selected
    — AI", per-row "Send AI"): they checked `automail.enabled` (background-Automail's own toggle) instead
    of the actual AI-enabled flag — now check `ai.enabled` correctly.
  - Schema: `automailsend_app_state` +`ai_temperature real default 0.4` +`ai_match_strictness integer
    default 0`.
  - **Verified**: migration applied + confirmed live, clean `frontend` build (first try), backend
    `node --check` on all four touched files. **Not verified**: still no real Gemini key in either `.env`
    file, so temperature's actual effect and the strictness skip behavior haven't been click-tested —
    same standing caveat as the platform-AI phase this builds on.

- **2026-08-18** — **Platform-managed AI: BYOK removed, admin-granted credits added.** Operator's own idea
  ("we do not let the user provide their API... we use Gemini as our source AI agent provider and we
  provide credits instead"). Confirmed via `AskUserQuestion` before building: hard switch (no BYOK
  fallback), a Gemini key **dedicated to Cuneihire** (separate from the operator's other already-in-use
  shared Gemini key in the global credentials file — deliberately not reused, to keep cost/quota
  attribution clean), admin-granted credits only (no payment flow exists in this codebase).
  - Schema: `automailsend_app_state` +`ai_personalization_enabled boolean` +`ai_credits integer default
    20`; old `ai_provider`/`ai_api_key` left in place unused (this project's usual precedent).
  - `ai.service.js` / `aiClient.ts` collapsed from OpenAI/Groq/Gemini dispatch to Gemini-only — no UI path
    reaches the other providers any more. Both now read `GEMINI_API_KEY` from their own deployment's env
    (`backend/.env` for workers, `frontend/.env.local`/Vercel for the Next.js AI routes) instead of a
    per-user key.
  - New `backend/src/lib/aiCredits.js` + a same-logic inline pair in `aiClient.ts`: `spendAiCredit()`,
    atomic via optimistic-locking conditional update (no new Postgres function needed) — spent *after* a
    successful Gemini call, never before.
  - `/api/ai-enhance` and `/api/resume-import` were unauthenticated before (never touched the DB) — now
    both verify a real `Authorization: Bearer` session token (`getAuthedUserId()`, mirrors
    `verifyAdmin`'s pattern) before spending a credit, so a client can't spoof another user's id.
  - `AutomailModal.tsx`: Provider/Model/API-Key fields gone, replaced with an "Enable AI Personalization"
    checkbox + read-only "Credits remaining: N". `AdminPortal.tsx` gained a per-row numeric AI-credits
    editor (`CreditsCell`), wired through the existing `/api/admin/users` per-user PATCH pattern.
  - **Blocking on the operator**: no real Gemini key has been dropped into either `.env` file yet (backend
    or frontend), and the production Vercel env var can't be set from this session (Vercel MCP not
    authorized). Needs `GEMINI_API_KEY` in `backend/.env`, `frontend/.env.local`, and Vercel's project
    settings before any of this actually works end-to-end.
  - **Verified**: migration applied + confirmed live, clean `frontend` build, `node --check` on all
    touched backend files. **Not verified**: no real AI call has been made against Gemini yet (no key in
    place) — first real test is the operator dropping the key in and trying an enhance/import/send/score.

- **2026-08-18** — **Roadmap audit + Tier 1: sent-log template/resume snapshot.** Operator asked for a
  completeness audit + roadmap of ideas (multi-platform scraping, a recruiter portal w/ AI-ATS, a
  dedicated AI settings tab — all deferred, explicitly big/strategic) before picking a next tier to build.
  Audit found the codebase clean (no TODOs, no dead imports from this session's refactors) but two real
  history gaps, closed this phase:
  - **`automailsend_sent_log` now snapshots which template/resume variant was actually used** per send —
    new `template_label text`/`resume_label text` columns (a label snapshot, not an FK — library rows get
    renamed/edited/deleted later, the log should reflect what was true at send time). Filled in at all 8
    insert sites across `batchSend.worker.js`/`automail.worker.js` (sent/failed/skipped/blocked cases) and
    `QuickSendModal.tsx`'s client-side `addSentLog` call (`"Custom"` when no library template was used at
    all). Surfaced in `JamsTab.tsx`'s per-recipient send history and the "Sent Email Preview" modal.
    Migration applied live + verified, both `supabase_setup.sql` copies mirrored.
  - **Fixed in passing**: `page.tsx`'s realtime `automailsend_sent_log` INSERT handler wasn't mapping
    `subject`/`body` into local state at all (only email/role/title/status/error/sentAt) — a live-inserted
    row showed blank until the next full reload. One-line fix sitting right next to the label-mapping
    addition already being made there.
  - Quick Send **was** already writing to `sent_log` correctly (`addSentLog` in `storage.ts`) — flagged as
    a possible gap during the audit write-up but confirmed present on closer check before acting on it.
  - **Not yet verified**: no live click-through — a real randomized send followed by checking the history
    row shows the right label. Build + worker syntax-check only.

- **2026-08-18** — **Post-ship QA fixes** (operator tried the freshly-built features and reported four
  concrete bugs/asks; all fixed same phase, no schema changes needed):
  - **Resume pagination**: both PDF export paths were producing one endlessly tall sheet instead of real
    A4 page breaks. Root causes, both in the same `.resume-print-area`: (1) the on-screen `transform:
    scale(0.82)` was still active during `window.print()` — a transformed subtree doesn't paginate across
    `@page` breaks in Chromium's print engine, so `@media print` now clears it (`transform: none
    !important`); (2) `.app-container`'s `height:100vh;overflow:hidden` shell stayed in the DOM (only
    `visibility` was toggled) and could clip anything taller than one screen — now forced to
    `height:auto;overflow:visible` under `@media print`. Separately, "Save to Resume Library"
    (`html2canvas` → `jsPDF`) was calling `addImage()` once with the whole tall canvas — `addImage` has no
    built-in pagination, so it just overflowed a single page; now slices the canvas across as many
    `pdf.addPage()` calls as needed (standard "long canvas → multi-page PDF" offset trick). See
    `ResumeBuilder.tsx`'s `handleSaveToLibrary` and `globals.css`'s `@media print` block.
  - **Resume Builder left column "cut in half"**: it had its own `maxHeight:78vh;overflowY:auto` nested
    *inside* `.main-content`, which already scrolls the whole page (`overflow-y:auto` from the app shell)
    — two scrollbars fighting each other read as an interrupted/clipped scroll. Removed the inner scroll
    box entirely; the form column now flows naturally in the page's own scroll. Made the preview column
    `position: sticky` so it doesn't disappear off-screen now that the form column is unbounded in height.
  - **No more preloaded roles**: `storage.ts`'s `ensureDefaultRoleDefs` used to silently seed
    DevOps/Fullstack/AI Automation/Custom for every brand-new user. Operator wants zero presets — every
    role built from scratch on Jobs & Roles. The role system itself (free-text `RoleDef` with
    keywords/salary/work-mode/location/etc., "+ Add title" flow, an existing "No roles yet" empty state)
    already supported this fully; the only actual bug was the auto-seed. `ensureDefaultRoleDefs` is now a
    thin passthrough to `loadRoleDefs` — new users start with an empty role list. `DEFAULT_ROLE_DEFS` const
    removed from `types.ts`. Verified the three role-consuming components (`RoleTemplates.tsx`,
    `ResumesTab.tsx`, `ResumeBuilder.tsx`) all degrade gracefully on an empty `roleDefs` array (optional
    chaining / empty `.map()`, no crash) — `JobsRolesTab.tsx` already had the "No roles yet — add one to
    get started" empty state built in.
  - **Removed the "Start Tutorial" Joyride walkthrough** entirely, per explicit instruction — the button,
    `runTour`/`stepIndex` state, `startTutorial`/`handleJoyrideCallback`, the 18-step `steps` array, and
    the `<Joyride>` render block are all gone from `page.tsx`; `react-joyride` uninstalled from
    `package.json`/lockfile. The `id="tour-*"` attributes it used to target (on `RoleTemplates.tsx`,
    `SmtpConfigPanel.tsx`, `AutoFetchModal.tsx`, `AutomailModal.tsx`) were left in place — harmless,
    inert, not worth the extra diff to strip.
  - **Not yet verified**: no live click-through of the fixed pagination (a real multi-page resume, printed
    and saved-to-library, actually showing multiple A4 pages) or the fixed scroll — build + dev server
    smoke test only, same caveat as every phase this session.

- **2026-08-18** — **Resume Builder shipped** (a resumai.com-style structured builder — genuinely
  different from the file-attachment "Resumes" library from earlier the same day; that stays, this adds
  to it). Confirmed via `AskUserQuestion` before building: export via plain browser print-to-PDF (no new
  backend infra), 1–2 clean/functional layouts for now (not a full design pass — matches the operator's
  own earlier "function first, design later" direction), and yes — a built resume should be saveable
  straight into the existing Resumes file library.
  - Lives as a **Files / Builder** segmented sub-view inside the existing "Resumes" tab (`page.tsx`'s
    `resumesSubTab` state) — no new sidebar entry, deliberately, to avoid re-growing the tab count right
    after the JAMS consolidation work earlier this session.
  - New `automailsend_resume_profiles` table, one JSONB `data` column for the whole structured shape
    (`ResumeData` in `types.ts`: personalInfo/summary/experience/education/skills/projects/
    certifications/languages) rather than six normalized sub-tables — applied live, verified, mirrored
    into both `supabase_setup.sql` copies (still byte-identical).
  - `ResumeBuilder.tsx`: form-section-by-form-section on the left, a live preview on the right rendered
    by `lib/resumeTemplates/{Modern,Classic}Template.tsx` (pure presentational, no AI, no network call —
    exactly the "reaches itself... without using AI" the operator asked for). Debounced (~800ms) auto-save
    — too many fields for a per-click "Save" to be pleasant.
  - **Export reconciliation** (flagged in the plan, not asked-again): `window.print()` alone can't feed a
    file into the existing resume-library upload flow (no programmatic access to what the browser's print
    dialog produces), so "Download PDF" stays pure `window.print()` (a `.resume-print-area` + `@media
    print` block in `globals.css`, zero deps) while "Save to Resume Library" specifically uses two new
    small, purely-client-side libraries (`html2canvas` + `jspdf` — no Puppeteer, no backend) to capture
    the same preview into an actual PDF blob, upload it via the existing `uploadAttachment()`, and create
    an `automailsend_resumes` entry via last phase's `saveResume()`.
  - **Import — the one AI-powered path**, explicitly separate from the plain-binding builder itself: new
    `/api/resume-import` route extracts text from an uploaded PDF via `pdf-parse` (text-based PDFs only,
    v2 API — `new PDFParse({ data: buffer }).getText()`, not the old v1 `require('pdf-parse')(buffer)`
    shape), then a new `parseResumeText()` in `aiClient.ts` structures it into `ResumeData` for the user
    to review before saving (never auto-persisted). Gated on AI being configured, same as every other AI
    feature here.
  - **Verified**: migration applied + confirmed live, clean `frontend` `npm run build` (including the new
    `/api/resume-import` route), dev server smoke-tested on `/`, `/resumes`, `/templates`, `/emails` with
    no compile/runtime errors. One dev-server hiccup mid-session (Turbopack HMR cache genuinely corrupted
    — "Module not found: Can't resolve '@/components/ResumesTab'" despite that file existing and building
    fine from a clean production build) — fixed by killing stray node processes, deleting `.next/`, and
    restarting fresh; not a real code bug, just a repeat of this machine's known Windows/Turbopack dev-
    server flakiness. **Not yet verified**: no live click-through of the actual builder (filling sections,
    watching the preview, printing, importing a real PDF, saving to the library) — that's the operator's
    own next step, same caveat as every other freshly-built send/UI path this session.
- **2026-08-18** — **Template library redesign: multiple email templates + a separate resume library,
  with per-recipient randomization.** Operator QA'd JAMS as "working nicely, what we actually wanted" (no
  further JAMS changes this round), then asked for a real template library instead of one template per
  role. Clarified via `AskUserQuestion`: resume files are a **genuinely separate library** from email
  templates (not files bundled into a template), each with its own default + randomizer pool — lets
  someone rotate resume version independently of pitch text.
  - Schema: `automailsend_templates` gained `label`/`is_default`/`in_randomizer`, its old
    `unique(user_id, role)` constraint (which made multiplicity impossible) dropped, backfilled existing
    rows to `is_default = true`; also gave it a missing **delete** RLS policy (it never had one — fine
    when it was upsert-only, not fine now that per-row deletion is a normal operation). New
    `automailsend_resumes` table, same shape (label/files/is_default/in_randomizer), no subject/content.
    Applied live via the Management API script; verified the constraint is actually gone and both tables'
    columns match before writing any app code against them.
  - Shared `pickFromPool(rows)` selection logic in **both** `backend/src/lib/templatePicker.js` and
    `frontend/src/lib/templatePicker.ts` (mirrored, "keep in sync," same reasoning as `crypto.ts`/
    `crypto.js`): 2+ rows flagged `in_randomizer` → random pick among those; else the `is_default` row;
    else the first row (defensive). Direct call test covered all branches including "never picks the row
    that isn't in the pool." Both `automail.worker.js`/`batchSend.worker.js` now fetch the full
    template/resume arrays per role and call `pickFromPool()` **per recipient** (not once per batch) —
    that's what makes randomization actually vary send-to-send instead of picking once and reusing it.
    Attachments merge from both the picked template's files and the picked resume's files.
  - Storage layer: replaced the old bulk `saveTemplates()` upsert-by-role (structurally incompatible with
    multiplicity) with real per-row CRUD (`saveTemplate`/`deleteTemplate`/`setDefaultTemplate` +
    `saveResume`/`deleteResume`/`setDefaultResume`), mirroring the existing `saveRoleDef`/`deleteRoleDef`
    pattern exactly. Templates/resumes are no longer part of the debounced `app_state` autosave blob —
    same treatment as `roleDefs`/`smtpAccounts` already got.
  - UI: `RoleTemplates.tsx` ("Templates & AI") rewritten as a list+detail library editor (Duplicate/
    Delete/"Set as default"/Randomize checkbox per template, explicit "Save changes" rather than
    per-keystroke saves). New `ResumesTab.tsx` + sidebar tab **"Resumes"**, same pattern, simpler.
    `QuickSendModal.tsx` gained a Template picker (Auto/Custom/specific) and a separate Resume picker
    (None/Auto/specific) — `Auto` shows a read-only preview of the default and re-resolves fresh via
    `pickFromPool()` at the actual moment of sending (not from the frozen preview), so it genuinely
    randomizes instead of always sending whatever rendered first.
  - Found and fixed in passing (directly in scope, not separately requested): `AdminPortal.tsx`'s template
    list used `key={tpl.role}` — a real duplicate-key bug now that a role can have multiple template rows;
    fixed to `key={tpl.id}` and shows the template's label/default flag in the heading.
  - **Verified**: schema confirmed via direct queries (columns, dropped constraint), `pickFromPool` direct
    call test (empty/single/multi/no-default-fallback/randomizes-only-within-pool), clean `frontend`
    `npm run build`, `node --check` on all three touched/new backend files, dev server smoke-tested
    (`/`, `/templates`, `/resumes`, `/emails`) with no compile/runtime errors, grep sweep for stale
    `Record<Role, RoleTemplate>` (singular)/`emptyTemplates`/`saveTemplates(` references — none found.
    **Not verified**: no live send was actually fired through this new code path (Quick Send with a real
    randomizer pool, or a real bulk/automail send) — the operator's own next click-through is the first
    real test of the actual send behavior, same caveat as every other unverified send path this session.
- **2026-08-18** — **Root-caused "popup expands the page instead of floating over it."** `QuickSendModal`
  and `JamsTab`'s sent-email preview modal used `.modal-overlay`/`.modal`/`.modal-header`/`.modal-footer`/
  `.close-btn` — **none of these classes exist in `globals.css`**. The real modal system (used correctly by
  `AutomailModal`/`AutoFetchModal`/etc.) is `.modal-backdrop` (fixed, full-viewport, centers its child) +
  `.modal-card` (the actual dialog) + `.modal-head` + `.modal-body`, rendered via `createPortal(...,
  document.body)` behind a `mounted` state (SSR-safety — `document` doesn't exist server-side). With no
  matching CSS, both modals were plain unstyled block `<div>`s with no `position: fixed`, so they rendered
  inline in the document flow instead of floating — exactly "extending the existing section." Rewrote both
  to the correct pattern (copied verbatim from `AutomailModal.tsx`, the proven reference). This was a
  pre-existing bug in the original `SendPanel.tsx`'s preview modal too, carried forward during the JAMS
  consolidation without being noticed — first time anyone actually looked closely at that modal's CSS.
  **Verified**: clean `npm run build`, dev server log has no new errors after the fix (the one stray "Fast
  Refresh...runtime error" line matches an HMR hiccup from adding the `createPortal` import mid-edit, not a
  new bug — no accompanying stack trace, and every request after it is a clean 200). **Not yet confirmed by
  the operator** that the popup now visibly floats centered over a dimmed backdrop rather than expanding
  inline — ask next time.
- **2026-08-18** — **Two real bugs fixed right after shipping Quick Send** (operator caught both by
  actually clicking through — first real live click-test of this session's work, including a real
  `POST /api/send 200`, confirming the synchronous send path genuinely works against live credentials).
  1. **Duplicate JSX**: `JamsTab.tsx`'s bottom render block had `<QuickSendModal>` and the (now-removed)
     "Email Automation Activity" popup each written out **twice**, so opening either rendered two
     overlapping instances at once ("give me two quick sends... repeat it two times"). Deduplicated to one
     of each.
  2. **Realtime channel collision**: the two `ExecutionLogsPanel` instances (scraper-filtered inline +
     automail-filtered popup, added earlier this same day) both open a Supabase channel under the same
     hardcoded name — mounting both threw `cannot add postgres_changes callbacks... after subscribe()`
     and crashed the tree, which is almost certainly what read as "clicking it doesn't open" / the page
     visibly glitching. Operator also just didn't want the split ("why is it here... we have our logs") —
     removed the "Email Automation Activity" popup and the `jobTypeFilter` prop entirely rather than
     fixing the collision; back to one unfiltered `ExecutionLogsPanel`, one "Automation Activity" button.
  3. **HR name/job title conflated**: `QuickSendModal` had one "HR name" field feeding *both*
     `{{name}}` (→ `author_name`) and `{{title}}` (→ `title`) at insert/send time — any template using
     both collapsed them to the same value ("Hi jhon," *and* "...the jhon position", from the operator's
     own real test send). Added a separate "Job title / position" field; `{{name}}` is the HR contact's
     name, `{{title}}` is the position, never the same input again. Also split in the AI-enhance prompt
     (`aiClient.ts`) — RECIPIENT NAME vs. JOB TITLE vs. CANDIDATE'S TARGET ROLE CATEGORY are now three
     distinct lines, not two.
  **Verified**: clean `frontend` `npm run build` after each fix, dev server log confirms the specific
  crash (`Uncaught Error: cannot add postgres_changes callbacks...`) stopped recurring after the removal,
  grep sweep for leftover `showEmailActivity`/`jobTypeFilter` references. **Not yet re-verified by the
  operator**: haven't confirmed with them that a fresh Quick Send now correctly keeps HR name and job
  title separate in a real sent email — worth asking after this lands.
- **2026-08-18** — **JAMS: Quick Send modal, queued-send feedback, split activity log.** Operator asked
  for four things; scoped down to three via `AskUserQuestion` (both times took the recommended option):
  templates stay **one per role** (no multi-template library this round), and **reply monitoring
  (IMAP-polling inbound replies into JAMS) is explicitly deferred to its own future phase** — it needs a
  new dependency, new worker, new schema, and only works for real-mailbox SMTP accounts (Gmail/custom),
  not SendGrid/Resend relays which have no inbox to poll. Don't build it opportunistically; plan it
  properly when picked up.
  - Replaced the inline add-a-contact row with a real **`QuickSendModal.tsx`**: HR name/email/phone, role
    → that role's saved template (optional, still editable after), an "Insert variable" picker, "✨
    Enhance with AI", and Send. **Key discovery**: `frontend/src/app/api/send/route.ts` already existed,
    fully working, with **zero callers** anywhere — Quick Send now uses it for a synchronous send (no
    batch-queue polling latency), which is also the actual fix for "why does a single send just sit there
    pending" — see `docs/architecture.md`'s new section for the full mechanism.
  - New frontend-side ports (documented as deliberately mirroring backend files, same as `crypto.ts`/
    `crypto.js` — **keep both ends in sync**): `frontend/src/lib/placeholders.ts` (mirrors
    `ai.service.js`'s `applyPlaceholders`/`hasUnresolvedPlaceholders`) and `frontend/src/lib/aiClient.ts`
    (mirrors `callAiJson`'s provider dispatch) behind a new `frontend/src/app/api/ai-enhance/route.ts`.
  - Table sends (bulk/per-row, still via the batch queue) now show "Queued — sending soon…" instead of a
    static Pending, via a `queuedIds` set in `JamsTab.tsx` cleared by realtime status changes.
  - `ExecutionLogsPanel.tsx` gained `jobTypeFilter?: "scraper"|"automail"`; the existing inline
    "Automation Activity" section is now scraper-only, a new "Email Automation Activity" button opens a
    popup for automail-only logs — not a second inline section (would just cost more vertical space).
  - **Verified**: clean `frontend` `npm run build`, dev server smoke-tested (`/`, `/emails`, a POST to
    `/api/ai-enhance`) with no compile/runtime errors, grep sweep for leftover references to the removed
    add-row state. **Not verified**: no real Quick Send was actually clicked through end-to-end (template
    pick → AI enhance → real send via a live SMTP account) — do that first before assuming this works
    against real credentials.
- **2026-08-18** — **JAMS consolidation: folded 4 tabs into one lifecycle hub.** Operator laid out the real
  target flow (connect SMTP → deterministic scraper finds HR contacts → AI writes+sends the outreach email
  → track it all in one place — AI's only job is the email) and said the fragmented navigation around it
  was unnecessary even though every capability behind it is still needed. Consolidated **Scraper &
  Contacts**, **Sending & Automail**, **Quick Send (AI)**, and **Logs** into **JAMS**: manual add-a-contact
  form (dropped the old bulk JSON/text importer — not needed on a tracking screen), per-row + bulk-select
  Send/Send AI/Resend reusing `SendPanel`'s exact `sendList()`/batch-queue logic, per-contact expandable
  send history (replaces the flat "All History" column), and `ExecutionLogsPanel` embedded as a collapsed-
  by-default "Automation Activity" section instead of its own tab. `RecipientManager.tsx`, `SendPanel.tsx`,
  `QuickSendTab.tsx` deleted; `page.tsx`'s sidebar/`TAB_NAMES` dropped 10→6 (JAMS is now the landing tab).
  Backend untouched — pure frontend IA change. Full design reasoning in `docs/architecture.md`'s "JAMS
  consolidation" section. **Verified**: clean `frontend` `npm run build`, dev server (`localhost:3001`)
  serves `/emails` without a compile/runtime error, grep sweep confirms no stray references to the deleted
  components or removed tab keys. **Not verified**: no live click-through with real Supabase data (add →
  send → history expand → resend) was done by me this session — next session should smoke-test that path
  once the operator confirms the SMTP/AI setup from the entry below actually works end-to-end.
- **2026-08-18** — **JAMS follow-up: moved the match board to Jobs & Roles + set up local ENCRYPTION_KEY.**
  Operator feedback right after JAMS shipped: matching is a *before-you-apply* question, so the browsable
  scored-job-post board belongs with the role's own criteria (Jobs & Roles), not the outreach tracker.
  Extracted the grouping logic (`groupRecipientsByJobPost`) and score styling (`matchScoreTone`) into
  `frontend/src/lib/jobPosts.ts`, and the card UI into `frontend/src/components/JobPostCard.tsx`, so
  `JobsRolesTab.tsx` (board + strictness slider, scoped to the active role's tab) and `JamsTab.tsx` (now a
  plain contact tracker — filters, status controls, match score shown read-only for context) share one
  implementation instead of drifting. `onUpdateStatus` was duplicated inline in `page.tsx` for both tabs;
  consolidated into one `handleUpdateRecipientStatus`.
  Separately: local `ENCRYPTION_KEY` was genuinely never set (both `backend/.env` and `frontend/.env.local`
  had it commented out — this is why adding an SMTP account silently failed; `frontend/src/lib/crypto.ts`
  throws if it's missing, and requires exactly 64 hex chars / 32 bytes for AES-256-GCM). Generated one
  matching value and set it in both files (gitignored, not committed) — **must stay identical in both**,
  frontend encrypts on save, backend decrypts to send. Local dev server restarted to pick it up (Next.js
  only reads `.env.local` at startup). Operator pasted a real Gmail app password in chat while debugging
  this — flagged as burned, told them to regenerate a fresh one rather than reuse it.
  **Verified**: full clean `frontend` `npm run build`. **Not verified**: no live SMTP account was actually
  added/tested by me (that's the operator's own action with their own credentials) — only confirmed the key
  is now present, correctly formatted, and matching in both files.
- **2026-08-18** — **JAMS built** (Job Application Management System — the deferred phase from the Jobs &
  Roles unification: "captures the rules data... does not implement matching/scoring — that's JAMS"). Key
  finding that shaped the whole design: scraped job posts have **no structured job data** at all (no title/
  salary/location columns anywhere, only a bounded free-text `context_text` snippet), so matching against a
  role's rules can't be a SQL comparison — it's an AI read of that snippet judged against the role's
  criteria. Operator chose **automatic scoring at scrape time** over an on-demand button (fits the app's
  automation-first philosophy; only costs an AI call for roles that actually have criteria set).
  - Schema: `match_score`/`match_reasoning`/`match_analyzed_at` added to both `automailsend_job_posts` and
    `automailsend_recipients` (denormalized, same pattern as `author_name`). `context_text` was also newly
    added to the frontend's `Recipient` type/`storage.ts` mapping — it existed in the DB and was already
    used server-side for AI prompts, but the frontend had never actually loaded it before now.
  - Backend: `ai.service.js` gained `scoreJobMatch()` + a new shared `callAiJson()` helper (extracted from
    `generateAiPersonalizedEmail`'s provider-dispatch so both share one implementation, not two). `scraper
    .worker.js`'s `processJob()` now selects full role rows (`select("*")`, was `key, keywords`) and reads
    `ai_provider`/`ai_api_key` from app_state; `saveContacts()` scores a newly-seen job post once (gated on
    `match_analyzed_at` being null and the role having real criteria — an all-`'any'` role is never scored,
    stays `null` rather than a meaningless value) and writes the result to both tables.
  - Frontend: old flat "Emails CRM" table (`EmailsTab.tsx`) fully replaced by `JamsTab.tsx` — job-post-
    centric cards (role, AI match-score badge, reasoning, expandable snippet, source link, per-contact
    status controls) grouped from `recipients` by `job_post_id`, plus a client-side strictness slider
    (`localStorage`-persisted, no schema needed) and a simple flat list for manual (non-scraped) contacts
    below, since those have no scrapeable context to score. Sidebar label "Emails CRM" → "JAMS" (tab key
    stays `'emails'`, no routing change). `EmailsTab.tsx` deleted (confirmed zero other references first).
  **Explicit scope boundary** (matches the plan): no applied/interviewing/rejected pipeline beyond the
  existing email/phone status, no re-scoring when a role's rules change later, no structured-field
  extraction — score + one-line reasoning only.
  **Verified**: DB migration applied live, both `supabase_setup.sql` copies mirrored; backend `node --check`
  + `require()` load tests on `ai.service.js`/`scraper.worker.js`; a direct call test confirming
  `scoreJobMatch` short-circuits to `null` (no AI call) for an all-`'any'` role, and that the
  `generateAiPersonalizedEmail`/`applyPlaceholders`/`hasUnresolvedPlaceholders` refactor caused no
  regression; full clean `frontend` `npm run build` (typecheck across `types.ts`/`storage.ts`/`page.tsx`/
  new `JamsTab.tsx`). **Not verified**: no live scrape/AI-call end-to-end test (needs a real LinkedIn cookie
  + AI provider key) — the scoring path has never actually been exercised against a real LinkedIn post.
- **2026-08-17** — **Design correction + pause.** Operator feedback on the rebrand pass above: too boxy,
  wanted soft edges back, and the hexagon mark looked stretched. Fixed: `globals.css` corners reverted from
  the zero-radius lock to moderate rounding (pills/badges/chips stayed pill-shaped, cards ~10-16px, controls
  ~8px), modal shadow restored. `HexMark.tsx` had a real geometry bug — the flat-top hex polygon is only
  regular when width:height ≈ 1:0.866, and it was being applied to square boxes everywhere (logo, splash,
  wordmark) — now computed automatically from one `size` prop. Decorative one-off hexes elsewhere
  (`LandingPage.tsx` avatar placeholders, step markers) simplified to plain circles rather than replicating
  the ratio math per call site. **Operator then asked to stop spending time on design and get back to
  functionality — confirmed, resuming the JAMS/functionality roadmap next**, design polish resumes later per
  the already-locked build→step-back→design sequencing in `docs/design.md`.
- **2026-08-17** — **Rebrand: Viddr/AutoMailSend → Cuneihire, new design system.** Operator pulled this
  forward as its own initiative (ahead of finishing JAMS/resume builder), gave full creative authority on the
  visual system. Reference pulled from a separate local repo `F:\Cuneihive-V3` (the operator's own agency
  site, archived — its last commit says active dev moved to a "Cuneihive-V4" repo not present on this
  machine, so that repo's `v4-*.png` screenshots were the only source for the newer look). Full locked
  palette/type/motif decisions: `docs/design.md` → Visual direction. Domain check: `cuneihire.com`/.ai/.io/
  .app/.co all came back with no DNS and no name collision — looks available, **not yet registered**
  (operator's action item).
  Implemented: full token + shared-class rewrite in `frontend/src/app/globals.css` (nearly every component
  consumes these by className, so this cascaded almost everywhere); new `frontend/src/components/ui/
  HexMark.tsx` brand-mark primitive (first file in a `ui/` folder, none existed before); name/logo swapped
  across `layout.tsx` (metadata + footer, dropped the old template author's credit line), `page.tsx` (splash,
  sidebar, Joyride copy), `login`/`signup` pages, `LandingPage.tsx` (full reskin — was raw Tailwind blue/
  rounded/shadow throughout, now token-driven + sharp/hairline per the design lock), `SmtpConfigPanel.tsx`
  (Gmail app-password instruction string), `frontend/package.json` name, `README.md`, `AGENTS.md`, `docs/
  project-requirement.md`, `docs/tools.md`, extension `manifest.json` (name/description only). Old raster
  `logo.png`/`icon.png` deleted, replaced with an inline SVG hexagon mark + `icon.svg` favicon.
  **Explicitly deferred** (see `docs/design.md`/plan file): `extension/manifest.json`'s `host_permissions`/
  `content_scripts` domain matches, `sitemap.xml`, `robots.txt` — these stay pointed at the current working
  domain until `cuneihire.<tld>` is actually registered and hosted, since swapping them to a domain that
  doesn't resolve yet would break the extension. The `automailsend_*` DB table prefix is untouched (internal
  schema naming, not user-facing, real live-data risk to rename). No dark mode added (none existed, not
  requested).
  **Standing preference recorded**: design/visual work for this project is never published as a Claude
  Artifact — stays local (operator correction after an initial mockup was published as one).
  **Verified**: full clean `frontend` `npm run build` (typecheck) after every batch of edits; final grep
  sweep confirmed zero residual "Viddr"/"AutoMailSend" strings under `frontend/src`; also swept and fixed 2
  pre-existing stray literal-color bugs found along the way (`var(--err)`, which was never defined, on the
  Admin Portal sidebar button; a hardcoded `text-blue-400` "running" log status) since they sat directly in
  code already being touched. **Not verified**: no visual/screenshot check was possible this session — the
  Playwright MCP is not connected in this environment despite being listed as a global plugin, and WebFetch
  can't reach localhost. The operator should open the local dev server themselves to confirm the visual
  result before this is considered fully done.
- **2026-08-17** — **Jobs & Roles: converted free text to fixed options** (same-day follow-up to the
  unification below). Operator directive: minimize free-text fields — fixed/enumerable choices should be
  dropdowns or chip-lists, not open text, both for UX consistency and because "fixed context = the AI
  consumes less/more consistent content" when these fields eventually feed matching/prompts. Kept
  `keywords` (chip list) and `otherNotes` (textarea) as the two deliberate free-text areas — everything
  else converted:
  - `salaryExpectation` (free text) → **`salaryCurrency`** (dropdown, `SALARY_CURRENCIES` in `types.ts`) +
    **`salaryPeriod`** (hourly/monthly/annual) + **`salaryMin`**/**`salaryMax`** (numbers).
  - `preferredLocation` (free text) → **`preferredLocations`** (chip list — same add/remove UX as
    `keywords`, via a new shared `ChipListField` helper in `JobsRolesTab.tsx`, just a separate list;
    work mode already covers remote/on-site/hybrid, this is purely geography, entered like "Pakistan" +
    Enter, one country/region per chip).
  - **New fixed-option fields** (operator: "add what's essential, but keep it to options"), all default
    `'any'`: **`employmentType`** (full-time/part-time/contract/internship — internship added specifically
    because that's the case that started this whole thread), **`companySize`** (startup→enterprise),
    **`visaSponsorship`** (required/not-required/any).
  Old `salary_expectation`/`preferred_location` columns left in place, unused — same precedent as every
  other superseded column this project. Backend untouched — none of these new fields are read by
  `scraper.worker.js` yet (still just `keywords`), consistent with the earlier phase's explicit scope
  boundary: rules are captured now, matching/filtering logic is still JAMS, ahead on the roadmap.
  **Verified**: full clean `frontend` `npm run build` (typecheck across `types.ts`/`storage.ts`/
  `JobsRolesTab.tsx`).
- **2026-08-17** — **Jobs & Roles unification.** Per the operator's own real-world pain (his cousin's
  internship search): search keywords used to live separately from the role they targeted, in
  `AutoFetchModal`'s config. New **Jobs & Roles** page (`JobsRolesTab.tsx`, new `'jobs'` sidebar tab, placed
  between Profile and Templates) — each role now carries its own keyword aliases (soft-capped ~15) plus
  job-search "rules": work mode (remote/on-site/hybrid/any), salary expectation, preferred location, other
  notes. All free text except work mode, deliberately kept simple. **Explicit scope boundary**: this phase
  captures the rules data and keeps search fully functional — it does **not** implement matching/scoring
  scraped posts against these rules or the strictness-preference slider the operator described; that's JAMS,
  still ahead on the roadmap.
  `automailsend_role_defs` gained `keywords text[]`, `work_mode`, `salary_expectation`, `preferred_location`,
  `other_notes`. `automailsend_app_state.auto_fetch_keywords`/`auto_fetch_template_role` are now unused —
  left in place, same precedent as `delay_sec`/old `ai_prompt`/`app_state.config` (no real keyword data
  existed to migrate).
  `backend/src/workers/scraper.worker.js`: `processJob()` now resolves the flat `{keyword, role}` mapping
  list from `automailsend_role_defs` instead of parsing a JSON blob from `job.data` — passes it into
  `processJobLogic(job, logger, mappings)` as an explicit param. `scheduler.js`/`trigger.js` needed **no**
  changes — both already pass the whole `app_state` row as `job.data`; the role_defs lookup happens
  internally keyed on `job.data.user_id`.
  `RoleTemplates.tsx` **simplified**: role add/rename/delete moved out to `JobsRolesTab.tsx` (which reuses
  the same `handleAddRole`/`handleRenameRole`/`handleDeleteRole` handlers in `page.tsx`, now also has
  `handleUpdateRoleRules`) — RoleTemplates keeps only the role-tab switcher + template editing.
  `AutoFetchModal.tsx` **simplified**: keyword-mapping UI removed entirely, replaced with a one-line summary
  ("N keywords across M roles"); `canEnable` now checks whether any role has keywords, sourced from
  `roleDefs` instead of local state.
  **Real bug caught and fixed before it shipped**: `storage.ts`'s `saveRoleDef`, if naively extended to
  always send all 5 new columns, would have silently wiped a role's keywords/rules on every rename-only
  call (like the existing `handleRenameRole`, which only ever passed `key`/`label`). Fixed by making the
  update path only touch columns actually present in the call (`!== undefined` check per field) — insert
  still defaults every field for brand-new roles.
  **Verified**: DB migration applied live; `node --check` + `require()` load test on `scraper.worker.js`
  (and a full backend load test including `scheduler.js`); a direct test proving the keyword→mapping
  flattening produces the exact `{keyword, role}` shape the existing send loop already expects; full clean
  `frontend` `npm run build`. **Known gap, deferred to the design pass**: the onboarding tour
  (`page.tsx`'s Joyride `steps`) still references 3 element IDs (`#tour-autofetch-keywords`/`-role`/`-add`)
  that no longer exist after this simplification — react-joyride skips missing targets rather than
  crashing, so this is cosmetic (a few tour steps silently no-op), not functionally broken. Needs a proper
  re-index (and likely a new step pointing at the Jobs & Roles page) next time the tour itself is touched.
- **Locked (2026-08-17, operator directive):** keep in-app copy terse — see [design.md](design.md). Sequencing
  for remaining roadmap phases is **build everything → step back → dedicated design pass**, not phase-by-phase
  polish — also in [design.md](design.md).

- **2026-08-17** — **Candidate Profile + fixed prompt variables + hard pre-send gate.** Follow-on to the
  same day's placeholder-fill fix, per operator request (fixed variable set, guardrails, never send with a
  literal unresolved token). Confirmed via AskUserQuestion:
  - **Profile is its own section, not per-role** — contact info is one-per-person, would just be duplicated
    across every role otherwise. New `ProfileTab.tsx`, new sidebar tab (`page.tsx`'s `TAB_NAMES`), placed
    right after Scraper & Contacts.
  - **Resume is a simple URL field for now** — not upload/template builder (still the last roadmap phase).
  Final 8-token variable set, documented in `RoleTemplates.tsx`'s hint: job-side `{{title}}`/`{{name}}`
  (best-effort, scraped, blank not guessed) + candidate-side `{{candidate_name}}`/`{{candidate_email}}`/
  `{{candidate_phone}}`/`{{candidate_portfolio}}`/`{{candidate_resume_link}}` (fully user-controlled, from
  the new Profile page). No `{{company}}` — still no reliable source, same reasoning as the earlier fix.
  `automailsend_app_state` gained 5 columns (`candidate_name`/`_email`/`_phone`/`_portfolio_url`/`_resume_url`)
  — extends the existing one-row-per-user table rather than a new one, same pattern as `candidate_info`.
  The existing "Candidate Info" free-text textarea **moved from `AutomailModal.tsx` to the new Profile
  page** (same `automail.candidateInfo` state/save path, just relocated in the UI — first concrete step on
  the "declutter the modals" complaint).
  `ai.service.js` is the single source of truth for two shared functions, both exported: `applyPlaceholders`
  (now takes an optional `profile` param, fills all 8 tokens) and **new** `hasUnresolvedPlaceholders` —
  the hard guardrail. Both `automail.worker.js` and `batchSend.worker.js` build a `profile` object from
  their already-`select("*")`'d app_state row and call it right before the SMTP send: if a literal
  `{{...}}` survives in the final subject or body, the send is **blocked** (logged, `sent_log` row with
  status `"failed"` and a clear reason, recipient marked `"failed"`) rather than delivered — and the
  `continue` happens before the account is ever picked up in the try/finally, so no SMTP quota is spent on
  a send that never happened. `generateAiPersonalizedEmail`/`buildUserMessage` also gained a
  `CANDIDATE CONTACT INFO` block (only the lines actually filled in — omitted, not blank, when not set) so
  the AI has real facts instead of inferring them, and the system prompt now tells it to sign off with
  contact details **only when given**.
  Confirmed `/api/send` (frontend API route) is dead code — no component calls it (both `SendPanel`'s
  batch-send and `QuickSendTab`'s quick-send flip `batch_send_pending` and route through the same two
  workers above); left untouched.
  **Verified**: DB migration applied live; backend `node --check` + `require()` load test on all 3 touched
  files; a direct call test proving `applyPlaceholders` fills known fields and blanks (not literal) unknown
  ones, and `hasUnresolvedPlaceholders` correctly flags a genuinely leftover token while passing clean text;
  full clean `frontend` `npm run build` (typecheck across `types.ts`/`storage.ts`/`page.tsx`/`ProfileTab.tsx`/
  `AutomailModal.tsx`/`RoleTemplates.tsx`). **Not verified**: no live AI-call or live send test (needs a
  real API key + SMTP account).

- **2026-08-17** — **Fixed the "variables don't fill in" bug** (real-world report: operator's cousin's
  internship emails weren't personalizing). Root causes, all fixed:
  1. `scraper.worker.js` hardcoded `title: ""` on every auto-fetched recipient — `{{title}}` was silently
     blank for every scraped contact (only manual entries ever had a title). Now set to the search keyword
     that found the contact (closest available proxy for "job title").
  2. The LinkedIn post's author name (`actorName`) was already being extracted internally for post
     attribution, then discarded. Now persisted as `author_name` on both `automailsend_job_posts` and
     (denormalized, like `context_text`/`source_url`) `automailsend_recipients` — new `{{name}}` template
     variable, real name when known, deliberately blank rather than guessed when not (job_posts upsert only
     overwrites `author_name` when a resolved value exists, so a later unresolved pass can't blank out an
     earlier good one).
  3. In AI mode, the AI's output fully replaced the template subject/body, so even correctly-filled
     placeholders never survived, and the AI had to guess facts from noisy raw post text. `ai.service.js`'s
     prompt now receives explicit labeled `CONTACT NAME` / `SEARCH KEYWORD` fields instead of leaving the AI
     to infer them, and is told never to echo `{{...}}`/`[...]` tokens. Both workers also run
     `applyPlaceholders()` as a safety-net pass *after* the AI branch resolves subject/body, not just before.
  4. `applyPlaceholders()` existed as **four separate copies** (a dead one in `ai.service.js`, live ones in
     both workers, a dead one in `SendPanel.tsx`) — exact same drift risk as the `delay_sec` bug below.
     Consolidated to one version, exported from `ai.service.js`, imported by both workers; the two dead
     frontend/service copies were deleted rather than fixed.
  DB migration (`author_name` on both tables) applied live. Company name was deliberately **not** added as
  a guaranteed variable — nothing in the scrape reliably identifies it (unlike the author's name, which
  LinkedIn's wire format gives directly), and fabricating an extraction heuristic here would reintroduce the
  same wrong-attribution problem the CRM fix below already solved once. The AI prompt still allows mentioning
  a company name *if* JOB POST text states one, same as before.
  **Verified**: backend `node --check` + a live `require()` load test on every touched file (with real env),
  a direct call test proving `{{name}}` fills when known and blanks (not literal) when not, and a full clean
  `frontend` `npm run build` (typecheck across `types.ts`/`storage.ts`/`SendPanel.tsx`/`RoleTemplates.tsx`).
  **Not verified**: no live AI-call or live scrape end-to-end test (needs a real API key + LinkedIn cookie).
- **Locked decision (2026-08-17, for the next phase — not yet built)**: operator proposed consolidating role
  management. Today, a "role" (`automailsend_role_defs`) is just a label, while its LinkedIn search keywords
  live separately inside `AutoFetchModal`'s config blob — operator found this split confusing (had to
  configure keywords in Settings, separately from the role itself). **Next phase**: a unified "Jobs/Roles"
  page where each role carries its own keywords/aliases *and* job-search criteria (remote/on-site/hybrid/any,
  salary range, preferred country, "other related stuff" — open-ended, likely feeds the JAMS match/preference
  slider) directly, in one place — `AutoFetchModal` would keep only true scraper mechanics (interval,
  pagination, LinkedIn cookies), not per-role config. Email template editing (subject/body/attachments)
  stays a **separate** tab, not folded into this — operator was explicit about that split. This supersedes
  the plain "give roles their own page" idea from the earlier audit; fold the two together when building it.
- **2026-08-17** — **Shipped Phase 1 of the auto-apply roadmap: dynamic roles + multi-SMTP pooling.**
  (The roadmap itself was written as a local audit, per the operator's standing "no online artifacts" rule —
  see [[no-online-artifacts]] in the personal memory index — not published anywhere; ask the operator if you
  need to see it again, or reconstruct from this log.)
  - **Part A — dynamic roles**: the old hardcoded 4-value `Role` type and the 3-keyword auto-fetch cap are
    gone. New `automailsend_role_defs` table (user-owned `key`/`label` pairs); `role` columns elsewhere were
    already plain `text` so no data migration was needed there. `Role` is now just a `string` type alias
    (kept the name to minimize the diff — this was an explicit operator choice, not a rename to `target`).
    New-user default seeding (the original 4 roles) happens client-side in `storage.ts`'s
    `ensureDefaultRoleDefs`. `RoleTemplates.tsx` now has inline add/rename/delete for roles (rename only
    touches the label, never the stored `key`, so existing recipient/template rows stay linked). Every
    component that read `ROLE_LABELS`/`ROLES` (`AutoFetchModal`, `SendPanel`, `EmailsTab`, `QuickSendTab`,
    `RecipientManager`, `RoleTemplates`) now takes a `roleDefs` prop and uses the new `roleLabel()` helper.
  - **Part B — multi-SMTP pooling**: the single `automailsend_app_state.config` credential is replaced by
    `automailsend_smtp_accounts` (N per user, each with its own `daily_limit`, default 50). New shared
    `backend/src/lib/smtpPool.js` (`loadAccountPool` + `buildTransporter`) is used by both
    `automail.worker.js` and `batchSend.worker.js` — each send picks whichever active+verified account has
    the most remaining quota, decrementing on both success *and* failure (so a broken account rotates away
    instead of absorbing every subsequent attempt). `sent_log.smtp_account_id` records which account sent
    what. `SmtpConfigPanel.tsx` is now a list manager (add/edit/remove), reusing the existing `/api/verify`
    flow per account. Old `app_state.config`/`smtp_email`/`smtp_password`/`daily_mail_limit` are left in
    place, unused — no real accounts existed yet to migrate.
  - **Also fixed in passing** (flagged as an open item in the prior entry, folded in since this rewrite
    touched the same send-loop code anyway): `batchSend.worker.js` now reads `send_delay_sec` like everywhere
    else, not the orphaned `delay_sec`.
  - **Verified**: `frontend`: `npm run build` (full clean build, including static page generation — this is
    the first time `.env.local` creds were live for a full build) + typecheck catching every missed
    reference across ~8 files. `backend`: `node --check` on every touched file, a `require()` load check for
    `smtpPool.js` and both rewritten workers, and a live read-only dry-run of `loadAccountPool`'s actual
    Supabase query (against a nonexistent user — confirmed it returns `[]` cleanly rather than erroring).
    **Not verified**: no real SMTP account or role def has been created and sent through end-to-end yet (no
    auth user exists to test with beyond the localhost dev account, which hasn't been used to add real
    accounts/roles) — first real signup should exercise this before trusting it fully.
  - **Open for Phase 2** (job visibility in-app) and **Phase 3** (resume builder) — not started, per the
    roadmap's recommended order which the operator approved as-is.
- **2026-08-17** — **Localhost dev auto-login.** Created one dev Supabase Auth user (credentials in
  `frontend/.env.local` as `NEXT_PUBLIC_DEV_AUTO_LOGIN_EMAIL`/`_PASSWORD`, gitignored — not printed to chat,
  generated + injected file-to-file). `app/[[...tab]]/page.tsx`'s auth effect now auto-`signInWithPassword`s
  with those instead of showing the login form / redirecting, **but only when `isLocalDevHost()`** —
  `NODE_ENV !== "production"` AND `window.location.hostname === "localhost"`, so this can never fire against
  a real deployment. Also transparently re-logs-in after a sign-out on localhost (same guard). Real Supabase
  Auth + RLS still runs underneath — there's no way to skip auth entirely while `auth.uid() = user_id` RLS
  policies gate every table, so this automates entering real credentials rather than removing auth. The dev
  account is a **plain user, not admin** (`NEXT_PUBLIC_ADMIN_EMAILS` isn't set at all yet) — add its email
  there too if the Admin Portal needs to be visible locally.
- **2026-08-17** — **Shipped Part 2: fixed the Emails CRM wrong-post-reference bug**, replacing the
  "in progress" entry below. Root cause was worse than first scoped: LinkedIn's content-search response
  isn't simple HTML — the visible post cards render through an internal React-Server-Components-style wire
  format (`window.__como_rehydration__ = [...]`, a JSON array of `"<hexId>:<value>"` chunks that reference
  each other by id), completely separate from the raw post metadata (`postSlugUrl`/`activityId`/`actorName`).
  Naive "nearest URL in the text" segmentation (the originally-planned fix) does **not** work — verified
  against a live captured sample that post metadata and a contact's actual rendered text can be 1M+
  characters apart with no textual proximity at all.
  **Working fix** (validated end-to-end against a real captured sample, not just theory):
  `backend/src/services/extraction.service.js` gained `extractContactsWithAttribution()` — properly
  `JSON.parse`s the rehydration array (not regex — regex-based chunk splitting produced false boundaries on
  ~2.4MB single chunks and was scrapped), splits the decoded stream into `<id>: content` chunks, finds each
  post's metadata chunk, and for every chunk containing an email/phone, walks up its `$<id>` reference chain
  (a few hops) to find either the post's own chunk directly or an ancestor mentioning that post's author
  name. Each contact gets **its own single, correctly-attributed** `source_url` + a real snippet of *that
  post's own text* as `context_text` — never a guess, and never someone else's post. Falls back to the old
  page-level extraction (unattributed, exactly today's behavior) if a response doesn't match the expected
  format — logged as a WARN so it's visible in execution logs, not silent.
  New DB table `automailsend_job_posts` (one row per distinct post: url + text, deduped per user) +
  `automailsend_recipients.job_post_id` FK — applied live via the same Management API flow as the entry
  below, added to `supabase_setup.sql`. `backend/src/workers/scraper.worker.js`'s `saveContacts` now upserts
  the owning post (cached per run) and writes `job_post_id`/`source_url`/`context_text` per contact instead
  of stamping every contact on a page with every post found on that page.
  **Caveat, be aware next time this needs touching**: only validated against the *initial* search-results
  page (a live sample the operator captured via a fresh LinkedIn cookie + `test_scraper.js`, saved to the
  session scratchpad, not the repo). The *paginated* endpoint (`LINKEDIN_PAGINATION_URL`, POST-based) almost
  certainly returns a different wire shape — not tested against a real paginated sample — so pagination-page
  contacts will likely hit the legacy fallback path (unattributed) until that's captured and verified too.
  Frontend got a matching but optional `Recipient.job_post_id` field (`types.ts`, `storage.ts`) — no UI
  changes were required since `EmailsTab.tsx`'s existing `source_url.split(',')` rendering already handles a
  single (or zero) URL correctly now that groups aren't joined together.
- **2026-08-17** — **Linked this project's actual Supabase** (previously nothing was linked at all — the
  bare `SUPABASE_*` names in the global credentials file belong to an unrelated "UMS" project). Turned out to
  be a **brand-new empty project** (ref `nqdujjpnanlueddgqvxj`, zero tables) — operator confirmed intentional.
  Credentials saved to this project's own gitignored `backend/.env` + `frontend/.env.local` (per that global
  file's own instruction not to auto-save operator tokens there, since the account is shared). Rewrote
  `supabase_setup.sql` as one consolidated, idempotent script (see [architecture.md](architecture.md) for the
  full reasoning) covering all 7 tables + the attachments storage bucket + RLS/policies/triggers, mirrored
  identically into both `backend/database/` and `frontend/database/`, and **applied it live** via the Supabase
  Management API — verified all 6 tables + bucket + 19 policies + RLS + the global_settings seed row exist.
  This includes the `candidate_info` column from the entry below, so that migration is now actually live, not
  just written. Found two schema/code mismatches while reconciling: attachments bucket name (**fixed** in the
  new script) and `delay_sec` vs `send_delay_sec` (**open**, see below).
- **2026-08-16** — Shipped the **AI prompt module** redesign (part 1 of 2; part 2 below is still open):
  replaced the free-text `ai_prompt` field with a hardcoded expert system prompt
  (`JOB_APPLICATION_SYSTEM_PROMPT` in `backend/src/services/ai.service.js`) + a single user-supplied
  **Candidate Info** variable (who the user is — skills/experience/what they want). Touched:
  `ai.service.js` (new `buildUserMessage()`), `automail.worker.js` + `batchSend.worker.js` (both call sites,
  now read `candidate_info` instead of `ai_prompt`), `frontend/src/lib/types.ts` (`AutomailConfig.aiPrompt` →
  `candidateInfo`), `frontend/src/lib/storage.ts`, `frontend/src/components/AutomailModal.tsx` (textarea
  swapped). DB migration applied live as of the entry above. Old `ai_prompt` column doesn't exist in the new
  schema at all (this being a fresh DB, there was no old data to preserve).
  Verified via `frontend` `npm run build` (TS compiled clean) + `npm run lint` (no new errors) + backend
  `node --check` on touched files; no live AI-call test (would need a real API key/send).
- **2026-08-16** — Ran `/init` review pass on the existing `CLAUDE.md`/`AGENTS.md`: appended project
  structure/commands/data & auth/deploy-gotcha sections to `AGENTS.md` (left the generated Next.js-fork warning
  block untouched), and scaffolded the full context-docs brain (this file plus
  [project-requirement.md](project-requirement.md), [architecture.md](architecture.md), [structure.md](structure.md),
  [rules.md](rules.md), [design.md](design.md), [role.md](role.md), [tools.md](tools.md)).
- **Recent feature work** (per git log at session start): `AutomailModal` component for background email
  automation + AI personalization config; admin API endpoint for per-user automation data/logs; full admin
  portal for user management + global config settings.

## Locked decisions
- Two-tier access model is an **email allowlist** (`NEXT_PUBLIC_ADMIN_EMAILS`), not a DB role column — admin
  status is env-config, not user-editable data.
- Per-user feature gating is `is_blocked` / `allowed_products` on `automailsend_app_state`, admin-controlled.

## Open items
- **Orphaned Storage blob + 3 unmapped skill names** from the 2026-08-20 data-loss incident (see entry
  above) — cosmetic/minor, not blocking. Delete the junk PDF blob from Supabase Storage when convenient; ask
  the operator if they recall the 3 skill names that couldn't be reconstructed.
- **Paginated LinkedIn responses not yet validated** for the new post-attribution extractor (see the
  2026-08-17 CRM-fix entry above) — falls back to the old unattributed behavior for those, safely but not
  ideally. Needs a captured paginated-response sample to extend the fix there.
- No live send/scrape has actually been run against the new empty Supabase project yet (no real `auth.users`
  row exists to test inserts against) — everything above was verified via syntax checks, a real captured
  LinkedIn sample run through the extraction module directly, and a clean `npm run build`, not a full
  live end-to-end run through the actual worker/queue/DB path.
- No test suite anywhere in the repo (frontend has none, backend's `npm test` is a placeholder).
- **Resolved 2026-08-17**: hosting target is **AWS** (operator directive — see [tools.md](tools.md)), not
  Vercel, despite the default `public/vercel.svg` asset (that's just the Next.js starter template's leftover,
  not a signal). Specific AWS services not yet given — ask before assuming EC2/ECS/Amplify or wiring
  anything AWS-specific.
