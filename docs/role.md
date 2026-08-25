# Roles (access model)

> Global seed below, unedited — this project's concrete implementation follows under "This project."

## Default two-tier model
- **Operator (super-admin):** the platform owner. Full surface — everything, incl. admin/automation internals.
- **Standard user:** the lean product + opted-in add-ons. Never sees or reaches admin surfaces.

## Enforcement (three layers — UI-hiding is never enough)
1. **Nav** — hide what a role can't use (cosmetic).
2. **Route** — hard-guard admin pages server-side (redirect non-operators).
3. **Server action / API — the real boundary.** Gate the *action*, not just the page (hidden buttons are still
   POST-reachable). **Rule: gate the action, not just the page.**

Demo/no-auth mode = treat the local user as operator, so the full experience shows out of the box.

## Later seams
- Multi-tenant roles + subscription **entitlements** plug into the module registry without a rewrite (add-on
  flags → plan entitlements; roles → per-tenant roles).

## This project — concrete implementation
- **Admin = email allowlist**, not a DB column: `NEXT_PUBLIC_ADMIN_EMAILS` (comma-separated). Any Supabase-auth'd
  user whose email is in that list is admin.
- **Enforcement layer 3 (the real one):** every `/api/admin/*` route calls `verifyAdmin(req)` — validates the
  bearer token against Supabase, then checks the email against the allowlist. `AdminPortal.tsx` being
  hidden/shown client-side is cosmetic only; never rely on it.
- **Per-user entitlements** live in the `automailsend_app_state` table: `is_blocked` (kill switch) and
  `allowed_products` (feature gating), both set by admin via the Admin Portal and read/enforced server-side.
- No subscription/billing layer exists yet (no Stripe or plan code found) — `allowed_products` is the current
  stand-in for plan-based entitlements, matching the seed's "later seams" note above.
