# Project requirement

## What
**Cuneihire** (formerly "Viddr"/"AutoMailSend") — a multi-tenant bulk email tool. A user configures SMTP
(Gmail app password), builds a recipient list tagged by role (DevOps, Fullstack, AI Automation, Custom — or
auto-fetched from a LinkedIn search via the browser extension), sets a per-role email template (subject, body,
attachments), and sends the batch with a configurable per-email delay. On top of that manual flow sits
**Automail**: background/scheduled sending with AI-personalized content, run unattended by the backend worker.

## Who
- **End users** — sign up via Supabase Auth and use the product independently (their own SMTP creds, recipients,
  templates, automation config). Each other's data is isolated.
- **Operator (admin)** — Muhammad Sohaib Amin, gated by the `NEXT_PUBLIC_ADMIN_EMAILS` allowlist. Manages
  per-user access (`is_blocked`) and feature entitlements (`allowed_products`) through the Admin Portal, and can
  view any user's execution logs. See [role.md](role.md).

## Success looks like
- A user can go from "no setup" to "first batch sent" through SMTP Config → Recipients → Role Templates → Send
  without confusion.
- Automail runs unattended on schedule, personalizes via AI, and *never fails silently* — execution logs
  (visible to the user and to admin) reflect real outcomes, not optimistic assumptions.
- LinkedIn auto-fetch reliably turns a search URL + session cookie into a clean, role-tagged recipient list.
- Admin can see and control every user's access/entitlements without needing direct DB access.

See [architecture.md](architecture.md) for how the three deployables implement this, and [memory.md](memory.md)
for current state.
