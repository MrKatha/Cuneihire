// Shared human-readable translations for raw backend/protocol errors (2026-09-02, site audit — several
// spots surfaced a raw nodemailer/Supabase/fetch error string straight to a layman with no wrapper). Each
// function takes whatever string the relevant API handed back and returns something a candidate can
// actually act on, without exposing SMTP/HTTP internals. Extracted from EmailDetailPanel.tsx's
// formerly-local formatFriendlyError, which now imports friendlySendError from here instead of keeping its
// own copy — same logic, one place, reused by every component that shows a send/verify/AI/save failure.

// Nodemailer/SMTP failures — used wherever an email send or SMTP verify can fail (Quick Send, manual
// replies, the Emails detail panel's send history, the SMTP account form itself).
export function friendlySendError(raw?: string): string {
  if (!raw) return "Something went wrong while sending. Please try again.";
  const msg = raw.toLowerCase();
  if (msg.includes("auth") || msg.includes("credentials") || msg.includes("password") || msg.includes("535")) {
    return "Invalid email or password — double-check your login details or app password.";
  }
  if (msg.includes("timeout") || msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("network")) {
    return "Could not connect to the mail server. Check your connection and try again.";
  }
  if (msg.includes("rejected") || msg.includes("spam") || msg.includes("bounce")) {
    return "The recipient's mail server rejected this email.";
  }
  if (msg.includes("limit") || msg.includes("quota")) {
    return "You've hit your email provider's sending limit for today.";
  }
  return "Something went wrong while sending. Please try again.";
}

// LinkedIn cookie verification — the API route's own messages here (missing/expired cookies, decrypt
// failure) are already written for a person to read; only the catch-all "Network error: <raw exception>"
// case needs translating.
export function friendlyLinkedInError(raw?: string): string {
  if (!raw) return "Something went wrong connecting to LinkedIn. Please try again.";
  if (raw.startsWith("Network error:")) {
    return "Couldn't reach LinkedIn to check your session — check your connection and try again.";
  }
  return raw;
}

// Generic catch-all for everything else that isn't its own send/SMTP/LinkedIn failure (AI enhancement,
// Supabase inserts) — only overrides the fallback for a couple of recognizable, actionable patterns, and
// otherwise trusts the caller's own context-appropriate fallback text rather than guessing.
export function friendlyGenericError(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  const msg = raw.toLowerCase();
  if (msg.includes("duplicate") || msg.includes("unique")) return "That contact already exists.";
  if (msg.includes("network") || msg.includes("fetch failed") || msg.includes("timeout")) {
    return "Network error — check your connection and try again.";
  }
  if (msg.includes("credit")) return raw; // credit-gate messages are already written for a person
  return fallback;
}
