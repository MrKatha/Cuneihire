"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase";
import {
  roleLabel,
  type Recipient,
  type ReplyRecord,
  type RoleDef,
  type SentRecord,
} from "@/lib/types";
import { matchScoreTone, firstUrl, replyTypeInfo } from "@/lib/jobPosts";
import { friendlySendError } from "@/lib/friendlyError";
import { StatusPill } from "./JobPostCard";

// The fallback shown when no AI description exists yet for this recipient — a plain-text excerpt, not AI
// writing. As of 2026-09-03 this is the backend batch classifier's fail-open case (AI unavailable/exhausted
// when this post was scraped) or an old pre-classifier recipient still waiting on the on-demand
// /api/summarize-post backlog bridge — was the ONLY "The job" content until 2026-09-02 (operator: "AI is
// being used anyway... why don't we create a summary using AI... what's happening in the background should
// not be visible to the user, it's bothering me" — the plain-code truncation still read as raw scraped
// text). Plain truncation, no AI call — preserves real line/paragraph breaks (only collapses runs of spaces/
// tabs, and collapses 3+ blank lines down to one) instead of flattening the whole post into one line, then
// cuts at a word boundary. Paired with `whiteSpace: "pre-wrap"` wherever this renders.
function summarizePost(text: string, maxChars = 220): string {
  const collapsed = text.replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (collapsed.length <= maxChars) return collapsed;
  const cut = collapsed.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  return `${(lastBreak > maxChars * 0.6 ? cut.slice(0, lastBreak) : cut).trim()}…`;
}

// Exported (2026-09-01) so ResponseDetailPanel.tsx can reuse the same section/history-entry presentation
// instead of duplicating it — both panels show overlapping content (job context, send history), just in a
// different order/emphasis.
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <h3 style={{ margin: 0, fontSize: "0.72rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--muted)" }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

export function HistoryEntry({ record }: { record: SentRecord }) {
  const [expanded, setExpanded] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  // Computed once per mount via a lazy useState initializer, not called inline during render (React
  // Compiler purity rule flags a bare Date.now() in the render body, and still flags it inside useMemo —
  // a useState initializer is the one place the compiler accepts a one-time impure read). This only
  // needs to be "roughly now," not live-ticking.
  const [now] = useState(() => Date.now());
  const hasBody = !!(record.subject || record.body);
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "10px", padding: "0.55rem 0.7rem", display: "flex", flexDirection: "column", gap: "0.35rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
        <span style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.78rem" }}>
          <span className={`badge ${record.status === "failed" ? "danger" : record.status === "skipped" ? "" : "ok"}`}>{record.status}</span>
          {new Date(record.sentAt).toLocaleString()}
        </span>
        <span style={{ display: "flex", gap: "0.4rem" }}>
          {hasBody && (
            <button type="button" className="btn ghost" style={{ fontSize: "0.68rem", padding: "0.1rem 0.4rem" }} onClick={() => setExpanded((v) => !v)}>
              {expanded ? "Hide email ▾" : "View email ▸"}
            </button>
          )}
          {record.status === "failed" && (
            <button type="button" className="btn ghost" style={{ fontSize: "0.68rem", padding: "0.1rem 0.4rem" }} onClick={() => setShowWhy((v) => !v)}>
              {showWhy ? "Hide reason" : "Why?"}
            </button>
          )}
        </span>
      </div>
      {(record.templateLabel || record.resumeLabel) && (
        <div style={{ fontSize: "0.7rem", color: "var(--muted)" }}>
          {record.templateLabel && <>Template: <strong>{record.templateLabel}</strong></>}
          {record.templateLabel && record.resumeLabel && "  ·  "}
          {record.resumeLabel && <>Resume: <strong>{record.resumeLabel}</strong></>}
        </div>
      )}
      {record.nextFollowUpAt && new Date(record.nextFollowUpAt).getTime() > now && (
        <div className="hint compact" style={{ margin: 0 }}>
          Next follow-up scheduled for {new Date(record.nextFollowUpAt).toLocaleString()}
        </div>
      )}
      {showWhy && record.status === "failed" && (
        <div style={{ fontSize: "0.75rem", color: "var(--danger)" }}>
          {friendlySendError(record.error)}
          {record.error && (
            <div style={{ fontSize: "0.65rem", opacity: 0.7, marginTop: "0.2rem", wordBreak: "break-all" }}>
              Technical info: {record.error}
            </div>
          )}
        </div>
      )}
      {expanded && hasBody && (
        <div style={{ borderTop: "1px solid var(--line)", paddingTop: "0.45rem", fontSize: "0.78rem" }}>
          <div style={{ marginBottom: "0.35rem" }}>
            <strong style={{ color: "var(--muted)" }}>Subject:</strong> {record.subject || "(No Subject)"}
          </div>
          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{record.body || "(No Body)"}</div>
        </div>
      )}
    </div>
  );
}

type Props = {
  recipient: Recipient;
  roleDefs: RoleDef[];
  history: SentRecord[];
  replies: ReplyRecord[];
  onClose: () => void;
  // Reports a freshly-generated AI summary back up so the parent's in-memory recipients list picks it up
  // (see fetchAiSummary below) — the API route already persisted it, this just keeps this session's own
  // state in sync so reopening the same recipient doesn't ask the network again.
  onAiSummaryGenerated?: (recipientId: string, summary: string) => void;
  // Deep-link a reply card straight to that exact reply in the Responses sub-tab (2026-09-03, operator:
  // "reply buttons... not taking me to the reply section"). See JamsTab.tsx's matching Props comment.
  onViewReply?: (replyId: string) => void;
};

// Consolidated "everything about this contact/email" view — a right-side slide-over replacing the old
// two-places-at-once split (an inline expand-row for history + a separate small centered modal just for
// one sent email's body). Operator ask, verbatim: "all the emails should be clickable... a popup like a
// sidebar from the right side... all the information about the email, like something about the job, the
// mail that we send, whether there are any follow-ups or not, if we receive a reply, and the link of the
// posts and everything." One place, not three.
export function EmailDetailPanel({ recipient: r, roleDefs, history, replies, onClose, onAiSummaryGenerated, onViewReply }: Props) {
  // Computed once per mount via a lazy useState initializer, not called inline during render (React
  // Compiler purity rule flags a bare Date.now() in the render body, and still flags it inside useMemo —
  // a useState initializer is the one place the compiler accepts a one-time impure read). This only
  // needs to be "roughly now," not live-ticking.
  const [now] = useState(() => Date.now());
  // AI job-post description — as of 2026-09-03 the PRIMARY path is the backend's own batched
  // classifyJobPosts() call (backend/src/services/ai.service.js), which writes ai_summary directly at
  // scrape time (scraper.worker.js's finalizeAndInsertGroup) using the same read that already decided this
  // post is a real job posting — no separate per-view Gemini call for any newly-scraped recipient. This
  // on-demand fetch (2026-09-02, kept 2026-09-03) is now only the BACKLOG/FAIL-OPEN BRIDGE: it fires the
  // first time this panel sees a recipient with context_text and no ai_summary yet — either an old
  // recipient scraped before this feature existed, or a new one saved while AI classification was
  // unavailable that run (credits/quota exhausted) — and caches from then on (server-side via the API
  // route, and here client-side so a reopen within this session doesn't ask the network again).
  // summaryFailed is a quiet, permanent-for-this-mount fallback to the plain-text excerpt — no error is
  // ever shown for this, it's an enhancement over a working fallback, not a critical path.
  const [summaryFailed, setSummaryFailed] = useState(false);

  useEffect(() => {
    if (!r.context_text || r.ai_summary || summaryFailed) return;
    let cancelled = false;
    async function fetchAiSummary() {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch("/api/summarize-post", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
          },
          body: JSON.stringify({ recipientId: r.id }),
        });
        const data = await res.json();
        if (cancelled) return;
        if (res.ok && data.success && data.summary) {
          onAiSummaryGenerated?.(r.id, data.summary);
        } else {
          setSummaryFailed(true);
        }
      } catch {
        if (!cancelled) setSummaryFailed(true);
      }
    }
    fetchAiSummary();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.id, r.context_text, r.ai_summary, summaryFailed]);

  const tone = r.job_post_id ? matchScoreTone(r.match_score) : null;
  const postUrl = firstUrl(r.source_url);
  const sortedHistory = [...history].sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());
  const sortedReplies = [...replies].sort(
    (a, b) => new Date(b.receivedAt || 0).getTime() - new Date(a.receivedAt || 0).getTime()
  );
  const followUpCount = r.followUpCount || 0;
  const nextFollowUp = sortedHistory
    .map((s) => s.nextFollowUpAt)
    .find((d) => d && new Date(d).getTime() > now);

  return createPortal(
    <div className="side-panel-backdrop" role="presentation" onClick={onClose}>
      <div
        className="side-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="email-detail-panel-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="side-panel-head">
          <div style={{ minWidth: 0 }}>
            <h2 id="email-detail-panel-title" style={{ margin: 0, fontSize: "1rem", wordBreak: "break-all" }}>
              {r.email || "No email"}
            </h2>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
              <StatusPill status={r.status} />
              <span className="chip">{roleLabel(roleDefs, r.role)}</span>
              <span className="hint compact" style={{ margin: 0 }}>{r.source === "manual" ? "Manual" : "Auto-fetch"}</span>
            </div>
          </div>
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
        </div>

        <div className="side-panel-body">
          {(r.title || r.job_post_id || postUrl || r.context_text) && (
            <Section title="The job">
              {r.title && <div style={{ fontSize: "0.9rem", fontWeight: 600 }}>{r.title}</div>}
              {r.author_name && <div className="hint compact" style={{ margin: 0 }}>Posted by {r.author_name}</div>}
              {tone && (
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <span style={{ color: tone.color, fontWeight: 700, fontSize: "0.8rem" }}>{tone.label}</span>
                </div>
              )}
              {r.context_text && (
                r.ai_summary ? (
                  <p style={{ fontSize: "0.8rem", color: "var(--muted)", lineHeight: 1.55, margin: 0, whiteSpace: "pre-wrap" }}>
                    {r.ai_summary}
                  </p>
                ) : summaryFailed ? (
                  <p style={{ fontSize: "0.8rem", color: "var(--muted)", lineHeight: 1.55, margin: 0, whiteSpace: "pre-wrap" }}>
                    {summarizePost(r.context_text)}
                  </p>
                ) : (
                  <div className="skeleton-line" style={{ width: "88%" }} />
                )
              )}
              {postUrl && (
                <a href={postUrl} target="_blank" rel="noopener noreferrer" className="btn ghost" style={{ alignSelf: "flex-start", fontSize: "0.75rem" }}>
                  View job post ↗
                </a>
              )}
            </Section>
          )}

          <Section title="Follow-ups">
            <div style={{ fontSize: "0.85rem" }}>
              {followUpCount > 0 ? `${followUpCount} follow-up${followUpCount > 1 ? "s" : ""} sent` : "No follow-ups sent yet"}
            </div>
            {r.lastSentAt && (
              <div className="hint compact" style={{ margin: 0 }}>Last contacted {new Date(r.lastSentAt).toLocaleString()}</div>
            )}
            <div className="hint compact" style={{ margin: 0 }}>
              {nextFollowUp
                ? `Next follow-up scheduled for ${new Date(nextFollowUp).toLocaleString()}`
                : "No follow-up currently scheduled"}
            </div>
          </Section>

          <Section title={`Replies${sortedReplies.length > 0 ? ` (${sortedReplies.length})` : ""}`}>
            {sortedReplies.length === 0 ? (
              <p className="hint compact" style={{ margin: 0 }}>No replies received yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                {sortedReplies.map((rep) => {
                  const { label, badgeClass } = replyTypeInfo(rep.replyType);
                  const isHuman = !rep.replyType || rep.replyType === "human";
                  return (
                  <div
                    key={rep.id}
                    role={onViewReply ? "button" : undefined}
                    tabIndex={onViewReply ? 0 : undefined}
                    onClick={() => onViewReply?.(rep.id)}
                    onKeyDown={(e) => {
                      if (onViewReply && (e.key === "Enter" || e.key === " ")) onViewReply(rep.id);
                    }}
                    title={onViewReply ? (isHuman ? "Open in Responses" : "Automated reply, not a person — open in Responses") : undefined}
                    style={{
                      // Dimmed border for an automated reply (ticket ack / OOO / bounce) so a genuine human
                      // reply still reads as the visually stronger signal at a glance (2026-09-04).
                      border: `1px solid ${isHuman ? "var(--accent)" : "var(--line)"}`,
                      borderRadius: "8px",
                      padding: "0.5rem 0.65rem",
                      fontSize: "0.8rem",
                      cursor: onViewReply ? "pointer" : undefined,
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                        {isHuman ? `↩ ${rep.fromEmail}` : rep.fromEmail}
                        {!isHuman && <span className={`badge ${badgeClass}`} style={{ fontSize: "0.65rem" }}>{label}</span>}
                      </span>
                      {rep.receivedAt && <span className="hint compact">{new Date(rep.receivedAt).toLocaleString()}</span>}
                    </div>
                    {rep.subject && <div style={{ marginTop: "0.2rem", fontWeight: 500 }}>{rep.subject}</div>}
                    {rep.bodySnippet && (
                      <div style={{ marginTop: "0.2rem", color: "var(--muted)", whiteSpace: "pre-wrap" }}>{rep.bodySnippet}</div>
                    )}
                    {onViewReply && (
                      <div className="hint compact" style={{ marginTop: "0.3rem", color: "var(--accent)" }}>View in Responses →</div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </Section>

          <Section title={`Emails sent${sortedHistory.length > 0 ? ` (${sortedHistory.length})` : ""}`}>
            {sortedHistory.length === 0 ? (
              <p className="hint compact" style={{ margin: 0 }}>Nothing sent to this contact yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                {sortedHistory.map((s, idx) => (
                  <HistoryEntry key={`${s.sentAt}-${idx}`} record={s} />
                ))}
              </div>
            )}
          </Section>
        </div>
      </div>
    </div>,
    document.body
  );
}
