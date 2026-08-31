# Candidate pricing tiers (spec)

> ClickUp `86eyrp54a`. **Superseded 2026-08-31 — real billing now exists** (Lemon Squeezy, shipped same
> day, `plan_tier` column live) — the "no self-serve payment build yet" framing below is stale; kept for
> the grounding facts, which still hold. **Live decision, same day**: three tiers — Starter / Pro / a third
> tier (name TBD) — each a base subscription *plus* pay-as-you-go credits on top (hybrid, not flat
> per-tier allotments only). Real margin targets given: **Starter 50%, Pro 45%, third tier 40%** on the
> subscription price; **50% on pay-as-you-go credits** (cost $0.02/credit → price $0.04/credit, confirmed
> math: `(0.04-0.02)/0.04 = 50%`). Cost basis: **~$10/month/user** (operator's own breakdown: ~$5
> infra/credits + ~$5 branding/marketing allocation) — **whether this $10 is flat across all three tiers or
> scales up for Pro/the third tier (which include more credits/keywords/fetch-frequency, so plausibly cost
> more to serve) is still open** — the price ladder doesn't come out sensibly assuming a flat $10 (see
> below), so this needs the operator's call before the actual $ price points can be finalized.

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

- Recruiter-side / AI-ATS tiers (`ats_ai_credits`) — separate future spec.
- Wiring `allowed_products` to actually gate features (e.g. hiding Automail from Free accounts in the UI).
- A credit auto-refill/reset job.

## Pay-as-you-go credits (2026-08-31 decision — fully specified, ready to implement)

Base subscription tiers grant a starting credit balance (today's `ai_credits`/`app_credits` columns);
running out doesn't block sending — the user can buy more, priced with a locked 50% margin:

| | Our cost | User price | Margin |
|---|---|---|---|
| Per credit (PAYG top-up) | $0.02 | **$0.04** | 50% |

This needs: a Lemon Squeezy one-time-purchase product (not a subscription) per credit pack size (e.g. 100/
500/1000 credits), a webhook handler variant that tops up `app_credits`/`ai_credits` directly instead of
touching `plan_tier` (the existing subscription webhook only handles recurring `data.type === "subscriptions"`
events — a PAYG purchase is a one-time order, a different Lemon Squeezy event shape, not yet handled), and a
"Buy more credits" entry point in `BillingCard.tsx`. Not yet built.

## Subscription tiers (2026-08-31 decision — structure locked, $ price points pending one clarification)

Three tiers, each base subscription + the PAYG credits above stacked on top:

| | **Starter** | **Pro** | **[third tier — name TBD]** |
|---|---|---|---|
| Target margin | 50% | 45% | 40% |
| Price | `cost / (1 − 0.50)` | `cost / (1 − 0.45)` | `cost / (1 − 0.40)` |

**Blocked on**: whether each tier's "cost to serve" is the same ~$10/mo or scales up per tier. Flat $10
across all three actually produces a *falling* price ladder (Starter $20 → Pro $18.18 → third tier
$16.67) since a bigger discount (lower margin %) on a flat cost means a lower price — the opposite of a
normal ascending SaaS ladder. That only resolves sensibly if cost scales with what each tier includes
(more `ai_credits`/`app_credits`/keyword headroom/fetch frequency → a higher real cost to serve) — e.g.
something like Starter $10 / Pro $18 / third tier $30 would produce a properly ascending $20 / $32.73 /
$50 ladder. Needs the operator's actual per-tier cost estimate, not a guess, before locking these numbers.
