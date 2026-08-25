// Mirrors backend/src/services/ai.service.js's applyPlaceholders/hasUnresolvedPlaceholders exactly —
// deliberately duplicated across the two deployables, same reasoning as crypto.ts/crypto.js (frontend
// can't import backend's CommonJS code). Needed here for the Quick Send modal's synchronous send path
// (frontend/src/app/api/ai-enhance/route.ts, components/QuickSendModal.tsx), which sends via /api/send
// directly instead of the backend's queue — so the same substitution + guardrail has to run client-side.
// KEEP IN SYNC with the backend copy; do not let the token set drift between the two (see docs/memory.md's
// note on this exact function having drifted three times before it was consolidated).
import type { CandidateProfile, Recipient } from "./types";

type PlaceholderRecipient = Pick<Recipient, "email" | "title"> & { author_name?: string };

export function applyPlaceholders(
  text: string,
  recipient: PlaceholderRecipient,
  profile?: Partial<CandidateProfile>
): string {
  const p = profile || {};
  return text
    .replaceAll("{{title}}", recipient.title || "")
    .replaceAll("{{name}}", recipient.author_name || "")
    .replaceAll("{{email}}", recipient.email)
    .replaceAll("{{candidate_name}}", p.name || "")
    .replaceAll("{{candidate_email}}", p.email || "")
    .replaceAll("{{candidate_phone}}", p.phone || "")
    .replaceAll("{{candidate_portfolio}}", p.portfolioUrl || "")
    .replaceAll("{{candidate_resume_link}}", p.resumeUrl || "");
}

// Hard guardrail: no email may ever be sent with a literal unresolved {{...}} token in it.
export function hasUnresolvedPlaceholders(text: string): boolean {
  return /\{\{\s*[\w.]+\s*\}\}/.test(text || "");
}

// The 8 fixed tokens, for the "Insert variable" picker in QuickSendModal.tsx — same set documented in
// RoleTemplates.tsx's HelpTooltip.
export const TEMPLATE_VARIABLES: { token: string; label: string }[] = [
  { token: "{{title}}", label: "Job title (search keyword)" },
  { token: "{{name}}", label: "Recruiter/poster name (if known)" },
  { token: "{{email}}", label: "Recipient email" },
  { token: "{{candidate_name}}", label: "Your name" },
  { token: "{{candidate_email}}", label: "Your email" },
  { token: "{{candidate_phone}}", label: "Your phone" },
  { token: "{{candidate_portfolio}}", label: "Your portfolio link" },
  { token: "{{candidate_resume_link}}", label: "Your resume link" },
];
