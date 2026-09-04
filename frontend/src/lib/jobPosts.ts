// Shared between JobsRolesTab.tsx (the "does this match what I'm looking for" discovery view — matching
// happens before you'd ever apply, so it lives with the criteria that define the match, not the outreach
// tracker) and JamsTab.tsx (which just needs the score as context on an already-found contact). Single
// source of truth for grouping recipients into job posts and reading a match_score's color/label, so the
// two screens can't drift on what "70" or "no score yet" means (see docs/memory.md for why this moved).
import type { Recipient } from "./types";

// Defensive fix (2026-08-25) for a real backend bug (now also fixed at the source in
// extraction.service.js): older scraped rows can have `source_url` as several LinkedIn post URLs joined
// with ", " into one string (a known legacy-extractor limitation — see that file's comment), which made
// "View post" links 404 since the joined string was never a valid URL. Already-stored rows won't rewrite
// themselves, so every render site takes just the first URL rather than trusting the raw column value.
export function firstUrl(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const first = raw.split(",")[0]?.trim();
  return first || undefined;
}

export type JobPostGroup = {
  jobPostId: string;
  role: string;
  authorName?: string;
  contextText?: string;
  sourceUrl?: string;
  scrapedAt?: string;
  matchScore: number | null;
  matchReasoning: string | null;
  contacts: Recipient[];
};

export function groupRecipientsByJobPost(recipients: Recipient[]): JobPostGroup[] {
  const groups = new Map<string, JobPostGroup>();
  for (const r of recipients) {
    if (!r.job_post_id) continue;
    let g = groups.get(r.job_post_id);
    if (!g) {
      g = {
        jobPostId: r.job_post_id,
        role: r.role,
        authorName: r.author_name,
        contextText: r.context_text,
        sourceUrl: firstUrl(r.source_url),
        scrapedAt: r.scraped_at,
        matchScore: r.match_score ?? null,
        matchReasoning: r.match_reasoning ?? null,
        contacts: [],
      };
      groups.set(r.job_post_id, g);
    }
    g.contacts.push(r);
  }
  return Array.from(groups.values());
}

export function matchScoreTone(score: number | null | undefined): { label: string; color: string } {
  if (score === null || score === undefined) return { label: "Not analyzed", color: "var(--muted)" };
  if (score >= 70) return { label: `${score} — Strong match`, color: "var(--ok)" };
  if (score >= 40) return { label: `${score} — Partial match`, color: "var(--warn)" };
  return { label: `${score} — Weak match`, color: "var(--danger)" };
}

// Shared between JamsTab.tsx's "Replied" badge and EmailDetailPanel.tsx's reply cards (2026-09-04) — a
// matched inbound reply can be a real human, or a company's own auto-response (helpdesk ticket ack,
// out-of-office, delivery bounce). All three are legitimate matches, but showing them all as an identical
// "↩ Replied" is misleading — found live when a JobSpy test send to a generic HR inbox came back as a
// Freshservice support-ticket confirmation, not a person. replyType itself is classified server-side
// (replyPoll.worker.js's classifyReplyType); this just maps it to a label/badge class for display.
export function replyTypeInfo(replyType: string | undefined): { label: string; badgeClass: "ok" | "warn" | "danger" } {
  if (replyType === "auto_ticket") return { label: "🎫 Auto-ticket", badgeClass: "warn" };
  if (replyType === "out_of_office") return { label: "📭 Out of office", badgeClass: "warn" };
  if (replyType === "bounce") return { label: "⚠ Bounced", badgeClass: "danger" };
  return { label: "↩ Replied", badgeClass: "ok" };
}
