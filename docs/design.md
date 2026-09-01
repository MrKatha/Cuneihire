# Design (product/UX principles)

> Global seed below, unedited — repo-specific notes follow under "This project."

## Durable principles
- **One consistent user-facing flow first, then a separate admin section.** Ship a lean, opinionated core that
  covers the common needs; keep operator/admin capability in its own surface.
- **Customization as opt-in add-ons**, not clutter — extras are off by default and toggled on, never deleted.
- **Admin vs standard user is a real split** — the operator gets the fuller interface; standard users get the
  clean product. Enforce it server-side, not just by hiding UI (see [role.md](role.md) / [rules.md](rules.md)).
- **Legible over clever.** Favor a clear, opinionated path over exposing every option. Explain empty states.
- **Honesty in the UI** — never display a number the system doesn't actually measure.

## Visual direction
- **Brand: Cuneihire** (2026-08-17, superseding "Viddr"/"AutoMailSend"). Tied in name/family to the operator's
  own agency **Cuneihive** (see global CLAUDE.md), but a deliberately different register — Cuneihive's own
  sites (reference pulled from `F:\Cuneihive-V3`, a separate local repo) read as premium/agency, wrong for a
  tool used daily. Full rationale, palette source, and locked decisions: `docs/memory.md`.
- **Tokens — palette "Signal" (2026-09-01, LOCKED, supersedes the original 2026-08-17 set below)**
  (`frontend/src/app/globals.css` `:root`): dark neutral ink `#181c1b`, crisp near-white paper `#f4f5f5`,
  one accent — deep teal `#0f7a6e` (AA-contrast-checked: 5.2:1 against white button text, 4.8:1 as text on
  the paper bg) — used sparingly (primary CTA, active states, hexagon mark), hairline border `#dde2e1`.
  Status colors: ok `#2e8f5c`, warn `#b8860c`, danger `#c23b4e`. Picked by the operator from 3 real
  candidates mocked up with actual app components (nav/panel/buttons/badges), not abstract swatches — see
  `docs/memory.md`'s top entry. Type/layout/motif below are unchanged by this — colors only.
  <details><summary>Original 2026-08-17 palette (retired 2026-09-01)</summary>
  Warm near-black ink `#16140f`, warm paper `#faf9f6`, copper-orange accent `#c9520e`, hairline border
  `#e5e1d6`, status colors ok `#1e8a5c` / warn `#c8960e` / danger `#b23a4a`. Retired because the operator
  didn't like it — in hindsight it read close to a generic cream-serif-terracotta AI-design default.
  </details>
- **Structure: soft, not sharp (corrected 2026-08-17)** — the first pass used a hard "sharp corners
  everywhere" lock; operator feedback was it read too boxy for this SaaS. Reverted to moderate rounding
  (~8px controls, ~10-16px cards/modals, pill badges/chips/progress) in `globals.css`'s shared classes, modal
  shadow restored. Don't re-introduce a zero-radius lock without asking again.
- **Hexagon geometry gotcha (fixed 2026-08-17)**: the flat-top hex clip-path (`polygon(25% 0%, 75% 0%, 100%
  50%, 75% 100%, 25% 100%, 0% 50%)`) is only a *regular* hexagon when its box is wider than tall by
  `sin(60°) ≈ 0.866` — applying it to a square box (the original bug) stretches it. `HexMark.tsx` now
  computes `height = size * 0.8660254` internally so callers just pass one `size`. Decorative one-off hexes
  scattered in `LandingPage.tsx` (avatar placeholders, step markers) were simplified to plain circles instead
  of replicating the ratio math at each site — the hexagon motif is reserved for the actual brand mark
  (`HexMark`/`Wordmark`), not scattered everywhere.
- **Type**: kept the already-loaded `Fraunces` (display/wordmark) + `DM_Sans` (UI/body) pair; added `Geist
  Mono` for the new tracked-uppercase eyebrow/label convention (`.label-eyebrow` in `globals.css`).
- **Motif**: a hexagon brand mark (`frontend/src/components/ui/HexMark.tsx` — the first entry in a `ui/`
  primitives folder, none existed before), used as the logo, status dots, and step markers. Restrained —
  not Cuneihive's honeycomb backdrops or storytelling diagrams.
- **Logo mark briefly reused Cuneihive's actual glyph, reverted same day (2026-09-01)**: shipped a version
  of `HexMark`'s "outline" variant that rendered Cuneihive's real split-hex logo image
  (`frontend/public/brand-mark.png`, from `F:\Cuneihive-V3\public\logo.png`) instead of the coded lookalike
  shape. Operator caught two problems: (1) they'd asked for an opinion, not an implementation — a process
  note, not a design one; (2) on reflection, sharing the literal mark between "Cuneihive" and "Cuneihire"
  (one letter apart in name) is a real confusability risk on top of the original 2026-08-17 tone concern,
  not just a redundant restatement of it. **Reverted to the coded hex mark** (this file's HexMark.tsx is
  back to the pre-9/1 shape) as a neutral placeholder — operator is sourcing a genuinely different logo
  separately. Don't re-introduce the Cuneihive glyph without being asked again.
- **Color palette LOCKED 2026-09-01 — "Signal"**: see the Tokens bullet above for the real values. Operator
  picked it from 3 candidates the same day. This is now the standard — any new module or update to an
  existing one follows these tokens (never a one-off hardcoded hex), per the operator's own instruction to
  finalize once and stay consistent. Favicon (`frontend/src/app/icon.svg`) updated to match; resume-document
  templates (`frontend/src/lib/resumeTemplates/*.tsx`) deliberately NOT touched — those are each their own
  independent document style for the exported resume PDF, not app UI chrome, and were never tied to these
  tokens even before this change (`ClassicTemplate.tsx` has always used its own greyscale, unrelated to
  `--accent`).

## This project
- The core flow is exactly the seed pattern: **SMTP Config → Recipients → Role Templates → Send**, all inside
  one tab-driven SPA route (`src/app/[[...tab]]/page.tsx`). **Automail** (background/AI-personalized sending)
  and **AutoFetch** (LinkedIn scraping) are opt-in add-ons layered on top, not part of the base flow.
- UI kit: Tailwind v4 + `lucide-react` icons + `react-hot-toast` (notifications) — no component library
  beyond that. (The `react-joyride` onboarding tour was removed 2026-08-18, operator directive.)
- **Keep in-app copy terse (2026-08-17, operator directive).** Default-visible hint text should be one short
  line; anything longer goes behind the existing `HelpTooltip` "?" pattern instead of a wall of paragraph text.
  Applies to every panel, not just what's already been trimmed (Profile, Templates, Automail).
- **Sequencing for the rest of the auto-apply build (2026-08-17, operator directive):** build functionality
  across the board first ("we will create everything"), pause for a holistic review once the feature set is
  complete, **then** do a dedicated visual/UX design pass — not phase-by-phase polish. Don't front-load design
  work into feature phases; functional-but-plain is correct for now. **Exception, same day:** the operator
  explicitly pulled the rebrand + design system forward as its own initiative (name/domain + visual identity),
  ahead of finishing the remaining roadmap features (JAMS, resume builder) — a deliberate one-off, not a
  reversal of the sequencing rule above for future feature work.
- **Design work for this project stays local, never published as a Claude Artifact** (2026-08-17, operator
  directive) — see `docs/memory.md`.
- **JAMS is the app's landing page (2026-08-25), replacing the old standalone Dashboard tab (deleted).**
  Sidebar order now starts with JAMS. JAMS itself is Overview/Emails/Monitoring sub-tabs, not three separate
  sidebar entries. **Settings is a flat grid of bordered cards (2026-08-26), not tabs** — same visual
  language as JAMS's Overview stat-tile/card layout, deliberately: SMTP Accounts, LinkedIn, Automation
  (Play/Pause), Email (who writes each role's email), Resume (a plain default-resume pointer, no AI
  controls), Account. The template libraries (Email Templates, Resumes) stay fully separate — Settings only
  holds config/connections, never content.
- **Card convention**: `border: 1px solid var(--line); border-radius: 12px; padding: 1.25rem` — the
  bordered-box look both JAMS's Overview and Settings use for every section.
