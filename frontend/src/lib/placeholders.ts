// Mirrors backend/src/services/ai.service.js's applyPlaceholders/hasUnresolvedPlaceholders exactly —
// deliberately duplicated across the two deployables, same reasoning as crypto.ts/crypto.js (frontend
// can't import backend's CommonJS code). Needed here for the Quick Send modal's synchronous send path
// (frontend/src/app/api/ai-enhance/route.ts, components/QuickSendModal.tsx), which sends via /api/send
// directly instead of the backend's queue — so the same substitution + guardrail has to run client-side.
// KEEP IN SYNC with the backend copy; do not let the token set drift between the two (see docs/memory.md's
// note on this exact function having drifted three times before it was consolidated).
import type { CandidateProfile, Recipient } from "./types";

type PlaceholderRecipient = Pick<Recipient, "email" | "title"> & {
  author_name?: string;
  lastSentAt?: string;
  followUpCount?: number;
};

export function applyPlaceholders(
  text: string,
  recipient: PlaceholderRecipient,
  profile?: Partial<CandidateProfile>
): string {
  const p = profile || {};
  // Follow-up-specific tokens (2026-08-31) — resolve safely in ANY template (KEEP IN SYNC with the backend
  // twin's identical comment/logic).
  const lastSentDate = recipient.lastSentAt ? new Date(recipient.lastSentAt).toLocaleDateString() : "";
  const followUpNumber = String((recipient.followUpCount || 0) + 1);
  return text
    .replaceAll("{{title}}", recipient.title || "")
    .replaceAll("{{name}}", recipient.author_name || "")
    .replaceAll("{{email}}", recipient.email)
    .replaceAll("{{candidate_name}}", p.name || "")
    .replaceAll("{{candidate_email}}", p.email || "")
    .replaceAll("{{candidate_phone}}", p.phone || "")
    .replaceAll("{{candidate_portfolio}}", p.portfolioUrl || "")
    .replaceAll("{{candidate_resume_link}}", p.resumeUrl || "")
    .replaceAll("{{last_sent_date}}", lastSentDate)
    .replaceAll("{{follow_up_number}}", followUpNumber);
}

// Hard guardrail: no email may ever be sent with a literal unresolved {{...}} token in it.
export function hasUnresolvedPlaceholders(text: string): boolean {
  return /\{\{\s*[\w.]+\s*\}\}/.test(text || "");
}

// For the "Insert variable" picker in QuickSendModal.tsx — same set documented in RoleTemplates.tsx's
// HelpTooltip. Deliberately does NOT include {{last_sent_date}}/{{follow_up_number}} (2026-08-31) — a Quick
// Send recipient has no last_sent_at/follow_up_count by definition (it's a one-off manual send), so those
// tokens would always resolve blank/"1" there; applyPlaceholders above still resolves them safely if
// someone pastes one in anyway, this just keeps them out of the picker where they'd be meaningless.
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
