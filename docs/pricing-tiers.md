# Candidate pricing tiers (spec)

> ClickUp `86eyrp54a`. **Spec only — operator decision (2026-08-26): no self-serve signup/payment build
> yet.** Accounts stay admin-created; tiers below are *presets an admin applies* using the same manual
> override columns that already exist (see [architecture.md](architecture.md)'s "Manual per-user plan
> overrides" section), not a new billing system. Candidate-side only — recruiter/AI-ATS tiers
> (`ats_ai_credits`) are a natural follow-up, out of scope here.

## Grounding facts (verified, not assumed)

- **AI cost is not the constraint.** Real Gemini pricing for the live model (`gemini-flash-latest` →
  `gemini-3.7-flash`): $0.75/$3.75 per 1M input/output tokens through 2026, rising to $1.50/$7.50 on
  2027-01-01. A typical personalization call runs a few thousand tokens — **~$0.002–0.005 per AI credit**.
  Tier limits below are a value/positioning lever and an abuse guard, not a cost pass-through.
- **Bulk email sends cost the operator $0** — every candidate sends through their own SMTP
  (`automailsend_smtp_accounts`), confirmed during the cost-metering task. Nothing to gate there on cost
  grounds either.
- **Blocking dependency: the platform's one Gemini key is still on the free tier — 20 requests/day, shared
  across every user, confirmed live** (`architecture.md`'s "Free-tier daily quota" section). Operator
  decision: stay there deliberately until real users exist, then apply for Google startup credits and move
  to a paid tier. **The AI-credit numbers below are sized for that post-upgrade world** — assigning
  meaningful per-user credit allowances now would just make everyone compete for the same 20 calls/day.
  Don't roll out AI-credit tiering before that upgrade happens.
- **Credits don't refill today.** `ai_credits` is a manually admin-topped-up balance (confirmed — no
  refill/reset job exists anywhere in the codebase). A tier framed as "N credits/month" needs a small
  scheduled refill job to become real; until then, "N credits" below means "granted once when the tier is
  assigned," same as today.
- **`allowed_products` is a dead field.** Stored via the admin API (`automailsend_app_state.allowed_products`)
  but never read anywhere in `backend/src` or checked to gate a feature in the frontend — confirmed via
  grep. It cannot gate "Pro-only features" like Automail today; the tiers below intentionally don't rely on
  it. Wiring it up (or retiring it) is separate work, not required for this spec.

## The four real levers (unchanged, already admin-settable per user)

| Lever | Column | Today's default | What it controls |
|---|---|---|---|
| AI credits | `automailsend_app_state.ai_credits` | 20 | Personalized-email/template-choice AI calls available |
| Keyword cap | `automailsend_app_state.max_keywords` | `null` (uncapped) | Total search keywords across all roles |
| Fetch interval floor | `automailsend_app_state.min_fetch_interval_override` | `null` (uses the 180min global floor) | Fastest allowed LinkedIn Auto-Fetch run interval |
| Daily send cap | `automailsend_app_state.daily_mail_limit` | 50 | `Math.min(this, global max_daily_send_limit)` — real enforced ceiling |

## Proposed tiers

| | **Free** — $0 | **Pro** — ~$15–20/mo | **Premium** — ~$35–45/mo |
|---|---|---|---|
| AI credits (initial grant) | 10 | 100 | 300 |
| Keyword cap | 10 | 30 | Uncapped (`null`) |
| Fetch interval floor | 180min (global default, no override) | 60min | 15min |
| Daily send cap | 20 | 75 | 150 |

Exact $ price points are a market call, not a technical one — positioned against comparable AI job-search
tools (LoopCV, Simplify, AutoApplyMax: free tiers exist; paid tiers cluster $15–30/mo; a premium tier near
$30–45 shows up on Jobright/AiApply). Adjust freely; the numeric levers are what actually need to be right.

## One real gap this surfaced: the daily-send ceiling doesn't stack cleanly yet

`automail.worker.js` computes the effective daily cap as `Math.min(user.daily_mail_limit, globalDailyLimit)`
— and `globalDailyLimit` (`automailsend_global_settings.max_daily_send_limit`) is **one platform-wide number,
currently 100**, not tier-aware. A Premium user's `daily_mail_limit` set to 150 would still be clamped down
to 100 by that global ceiling. Before Premium's higher daily cap can actually take effect, either:
- raise the global ceiling to at least the highest tier's value (simplest — it already means "hard safety
  ceiling regardless of tier," so raising it just widens that ceiling), or
- make the global ceiling itself tier-aware (more invasive, not needed unless the global ceiling is meant to
  stay meaningfully below Premium's number for its own reason).

Flagging this now so it isn't discovered by a confused "why isn't my Premium user's send cap working."

## Suggested (optional) immediate follow-up — not required for this spec

A nullable `plan_tier text` column (`'free' | 'pro' | 'premium'`) on `automailsend_app_state`, purely a
label — the admin panel would show "Pro" instead of four raw numbers, and it's the natural seed column for
a real billing integration later. Doesn't change enforcement (still the four columns above); cheap, low-risk,
and can ship independently whenever it's wanted. Not built as part of this spec-only task.

## Explicitly out of scope

- Self-serve signup/payment (Stripe or otherwise) — per the operator's 2026-08-26 decision.
- Recruiter-side / AI-ATS tiers (`ats_ai_credits`) — separate future spec.
- Wiring `allowed_products` to actually gate features (e.g. hiding Automail from Free accounts in the UI).
- A credit auto-refill/reset job.
