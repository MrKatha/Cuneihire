// Recruiter portal (2026-08-19 follow-up) — recruiter signup requires a company email, not a personal/
// free-mail address. Not an exhaustive list of every free-mail provider on earth, just the obvious
// well-known ones — good enough for the app-layer check this project already does everywhere else
// (is_blocked, admin allowlist, etc. are similarly plain checks, not exotic hardening). Client-side only;
// a determined user could bypass it, same trust model as the rest of this app.
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "gmx.com",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "rediffmail.com",
  "qq.com",
  "163.com",
]);

export function isCompanyEmail(email: string): boolean {
  const domain = email.trim().toLowerCase().split("@")[1];
  if (!domain) return false;
  return !PERSONAL_EMAIL_DOMAINS.has(domain);
}
