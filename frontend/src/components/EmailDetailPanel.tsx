"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import {
  roleLabel,
  type Recipient,
  type ReplyRecord,
  type RoleDef,
  type SentRecord,
} from "@/lib/types";
import { matchScoreTone, firstUrl } from "@/lib/jobPosts";
import { friendlySendError } from "@/lib/friendlyError";
import { StatusPill } from "./JobPostCard";

// A short excerpt, not the raw scraped post (2026-09-02, operator ask — "show a summary of the post not
// the actual post... if the user wants to read the post, they can go to the post link itself," which
// already sits right below this in the UI). Plain truncation, not a new AI call — collapses whitespace
// (scraped LinkedIn text often has awkward line breaks) and cuts at a word boundary rather than mid-word.
// If real AI-generated summaries are wanted later, this is the one function to swap.
function summarizePost(text: string, maxChars = 220): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  const cut = collapsed.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut).trim()}…`;
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
};

// Consolidated "everything about this contact/email" view — a right-side slide-over replacing the old
// two-places-at-once split (an inline expand-row for history + a separate small centered modal just for
// one sent email's body). Operator ask, verbatim: "all the emails should be clickable... a popup like a
// sidebar from the right side... all the information about the email, like something about the job, the
// mail that we send, whether there are any follow-ups or not, if we receive a reply, and the link of the
// posts and everything." One place, not three.
export function EmailDetailPanel({ recipient: r, roleDefs, history, replies, onClose }: Props) {
  // Computed once per mount via a lazy useState initializer, not called inline during render (React
  // Compiler purity rule flags a bare Date.now() in the render body, and still flags it inside useMemo —
  // a useState initializer is the one place the compiler accepts a one-time impure read). This only
  // needs to be "roughly now," not live-ticking.
  const [now] = useState(() => Date.now());
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
                <p style={{ fontSize: "0.8rem", color: "var(--muted)", lineHeight: 1.55, margin: 0 }}>
                  {summarizePost(r.context_text)}
                </p>
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
                {sortedReplies.map((rep) => (
                  <div key={rep.id} style={{ border: "1px solid var(--accent)", borderRadius: "8px", padding: "0.5rem 0.65rem", fontSize: "0.8rem" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
                      <span>↩ {rep.fromEmail}</span>
                      {rep.receivedAt && <span className="hint compact">{new Date(rep.receivedAt).toLocaleString()}</span>}
                    </div>
                    {rep.subject && <div style={{ marginTop: "0.2rem", fontWeight: 500 }}>{rep.subject}</div>}
                    {rep.bodySnippet && (
                      <div style={{ marginTop: "0.2rem", color: "var(--muted)", whiteSpace: "pre-wrap" }}>{rep.bodySnippet}</div>
                    )}
                  </div>
                ))}
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
