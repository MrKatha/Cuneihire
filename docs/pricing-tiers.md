# Candidate pricing tiers (spec)

> ClickUp `86eyrp54a`. **Superseded 2026-08-31 — real billing now exists** (Lemon Squeezy, shipped same
> day, `plan_tier` column live) — the "no self-serve payment build yet" framing below is stale; kept for
> the grounding facts, which still hold. **LOCKED 2026-08-31**: three paid tiers — **Starter / Pro /
> Elite** (no $0 tier — the free/lead-gen role moves to the public resume builder, a separate spec), each
> a base subscription *plus* pay-as-you-go credits on top. Margins: **Starter 50%, Pro 45%, Elite 40%** on
> the subscription price; **50% on pay-as-you-go credits** (cost $0.02/credit → price $0.04/credit).
> Cost-to-serve scales per tier (confirmed, not flat): **Starter $10 / Pro $18 / Elite $30 per month** →
> prices **$20 / $32.73 / $50**. Full table and the credit/keyword numbers under "Subscription tiers
> (LOCKED)" below.

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

## ~~Proposed tiers~~ — superseded by "Subscription tiers (LOCKED)" below

The original Free/Pro/Premium draft (illustrative $ ranges, no real cost math) is fully replaced by the
Starter/Pro/Elite table further down, which uses the operator's actual 2026-08-31 cost/margin decision. Kept
only as history — don't use the numbers above.

## One real gap this surfaced: the daily-send ceiling doesn't stack cleanly yet

`automail.worker.js` computes the effective daily cap as `Math.min(user.daily_mail_limit, globalDailyLimit)`
— and `globalDailyLimit` (`automailsend_global_settings.max_daily_send_limit`) is **one platform-wide number,
currently 100**, not tier-aware. An Elite user's `daily_mail_limit` set to 150 (see the locked tier table
below) would still be clamped down to 100 by that global ceiling. Before Elite's higher daily cap can
actually take effect, either:
- raise the global ceiling to at least the highest tier's value (simplest — it already means "hard safety
  ceiling regardless of tier," so raising it just widens that ceiling), or
- make the global ceiling itself tier-aware (more invasive, not needed unless the global ceiling is meant to
  stay meaningfully below Elite's number for its own reason).

Flagging this now so it isn't discovered by a confused "why isn't my Elite user's send cap working."

## Suggested (optional) immediate follow-up — not required for this spec

A nullable `plan_tier text` column (`'free' | 'pro' | 'premium'`) on `automailsend_app_state`, purely a
label — the admin panel would show "Pro" instead of four raw numbers, and it's the natural seed column for
a real billing integration later. Doesn't change enforcement (still the four columns above); cheap, low-risk,
and can ship independently whenever it's wanted. Not built as part of this spec-only task.

## Explicitly out of scope

- Recruiter-side / AI-ATS tiers (`ats_ai_credits`) — separate future spec.
- Wiring `allowed_products` to actually gate features (e.g. hiding Automail from an unsubscribed account).
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

## Subscription tiers (2026-08-31 — LOCKED)

Three tiers, all paid (no $0 tier any more — the free/lead-gen role moves to the public resume builder
below), each a base subscription + the PAYG credits above stacked on top. Cost-per-tier confirmed to scale
with what's included (operator decision, 2026-08-31), not flat:

| | **Starter** | **Pro** | **Elite** |
|---|---|---|---|
| Cost to serve | $10/mo | $18/mo | $30/mo |
| Target margin | 50% | 45% | 40% |
| **Price** (`cost / (1 − margin)`) | **$20/mo** | **$32.73/mo** | **$50/mo** |
| AI credits (initial grant) | 30 | 100 | 300 |
| App credits (initial grant) | 500 | 1500 | 4000 |
| Keyword cap | 10 | 30 | Uncapped (`null`) |
| Fetch interval floor | 120min | 60min | 15min |
| **Daily send cap** | **10** | **20** | **50** |
| **SMTP accounts allowed** | **1** | **1** | **1** |
| **AI-written emails** (write or AI-select) | **No** | **Yes** | **Yes** |
| **Follow-ups** | **0** | **1** | **3** |
| **Reply monitoring** | **No** | **Yes** | **Yes** |

The cost-to-serve column ($10/$18/$30) is the operator's own estimate, not derived from metered data yet
— revisit once `automailsend_ai_usage_log`/`automailsend_infra_usage_log` have real per-tier volume to
confirm it. The $ prices are exact given that cost input and the locked margins; psychological rounding
(e.g. $19/$32/$49) is a final polish call, not a math one. AI/app-credit and keyword/interval numbers are
still positioning calls (unchanged from the original illustrative table). The five **bolded rows are a
same-day revision** (2026-08-31, second operator pass) — daily send caps came down from an earlier draft
(30/75/150) to these real numbers, and four new levers were added: a single-SMTP-account cap (global,
temporary, same for every tier "for now" per the operator — not a real tier differentiator yet), the
AI-written-email gate (match-scoring AI stays available on every tier — this only gates AI touching the
email itself), the follow-up count cap, and reply monitoring. All four are now for-real enforced — see
docs/architecture.md's "Tier-gated feature limits" section for exactly which worker/UI checks which flag.

**Flagged, not yet decided (2026-09-03, operator):** the *daily* send cap as a headline promise may not be
honest at real-world scale — the same N distinct openings for one role genuinely won't exist fresh every
single day, so a daily-cap framing risks reading as a promise the scraper structurally can't keep. Operator's
proposed replacement: reframe as a **monthly** ceiling instead (their example: "up to 1,000 jobs/month" for
Pro) — a user-set daily cap still applies underneath if the user wants one, otherwise the scraper just sends
up to the monthly total, capped by whatever volume it actually finds. Explicitly deferred — "we will change
the package system later... first priority is to make the Indeed work." Revisit this alongside the
cost-to-serve refresh below (JobSpy/Indeed's AI classification calls aren't reflected in the $10/$18/$30
estimates yet either) when the package-structure phase starts.

**One open implementation question this surfaces, not blocking the numbers above**: every signup still
defaults `plan_tier` to `'free'` (`supabase_setup.sql`), and nothing currently forces a subscription choice
before the app is usable. With no $0 product any more, `'free'` needs to become either a time-boxed trial
state or simply "not yet subscribed, most features locked" — a real product decision for whenever
`plan_tier` gets wired to actually drive the five enforcement columns (see architecture.md's pipeline
breakdown). Flagging now so it doesn't get discovered as a bug later.
