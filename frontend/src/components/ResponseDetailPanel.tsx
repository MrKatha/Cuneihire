"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import { supabase } from "@/lib/supabase";
import { addSentLog } from "@/lib/storage";
import {
  roleLabel,
  type Recipient,
  type ReplyRecord,
  type RoleDef,
  type SentRecord,
  type SmtpAccount,
} from "@/lib/types";
import { matchScoreTone, firstUrl } from "@/lib/jobPosts";
import { friendlySendError } from "@/lib/friendlyError";
import { Section } from "./EmailDetailPanel";

function sentKey(email: string, role: string) {
  return `${email.toLowerCase()}::${role}`;
}

function replySubjectFor(original?: string) {
  if (!original) return "";
  return /^\s*re\s*:/i.test(original) ? original : `Re: ${original}`;
}

// A merged, chronological (oldest-first, like a real email thread) view of every message with this
// contact — our sent emails and their replies interleaved, not two separate lists (2026-09-02, operator
// ask: "I want a thread on each response... a back-and-forth conversation... completely monitored, so
// there's very little reason for the customer to leave this platform"). Local to this file, not exported —
// this layout is specific to this panel; EmailDetailPanel.tsx's HistoryEntry stays untouched.
type ThreadItem =
  | { type: "sent"; at: string; record: SentRecord }
  | { type: "received"; at: string; record: ReplyRecord };

function ThreadMessage({ item, contactLabel, showSubject }: { item: ThreadItem; contactLabel: string; showSubject: boolean }) {
  const isSent = item.type === "sent";
  const subject = item.record.subject;
  const body = isSent ? (item.record as SentRecord).body : (item.record as ReplyRecord).bodySnippet;
  const failed = isSent && (item.record as SentRecord).status === "failed";
  return (
    <div
      style={{
        borderLeft: `3px solid ${isSent ? "var(--accent)" : "var(--line)"}`,
        borderRadius: "4px",
        padding: "0.4rem 0.65rem",
        background: isSent ? "var(--bg-elevated)" : "transparent",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", fontSize: "0.72rem", color: "var(--muted)" }}>
        <span style={{ fontWeight: 600 }}>{isSent ? "You" : contactLabel}</span>
        {item.at && <span>{new Date(item.at).toLocaleString()}</span>}
      </div>
      {showSubject && subject && (
        <div style={{ fontWeight: 500, fontSize: "0.82rem", marginTop: "0.2rem" }}>{subject}</div>
      )}
      <div style={{ fontSize: "0.82rem", lineHeight: 1.5, whiteSpace: "pre-wrap", marginTop: "0.2rem" }}>
        {body || "(No message body)"}
      </div>
      {failed && (
        <div style={{ fontSize: "0.75rem", color: "var(--danger)", marginTop: "0.3rem" }}>
          Failed to send — {friendlySendError((item.record as SentRecord).error)}
        </div>
      )}
    </div>
  );
}

type Props = {
  reply: ReplyRecord;
  recipients: Recipient[];
  roleDefs: RoleDef[];
  sentLog: SentRecord[];
  replies: ReplyRecord[];
  smtpAccounts: SmtpAccount[];
  userId: string | null;
  onClose: () => void;
};

// The Responses tab's detail panel (2026-09-01) — operator ask: "this whole thing will look similar to
// the email section... we will see the same emails that we sent but it will focus more on the responses
// that we get... we can also do the manual response to the emails that we get... our SMTP will indicate
// what I want from here." Deliberately mirrors EmailDetailPanel.tsx's content (job context, send history)
// but reorders it reply-first, and adds the one genuinely new capability: composing and sending a manual
// reply through the SMTP account that actually received this message. AI-drafted replies are an explicit
// operator "later" — this is manual-only by design, not a missing feature.
export function ResponseDetailPanel({ reply, recipients, roleDefs, sentLog, replies, smtpAccounts, userId, onClose }: Props) {
  const [replyBody, setReplyBody] = useState("");
  const [replySubject, setReplySubject] = useState(() => replySubjectFor(reply.subject));
  const [sending, setSending] = useState(false);

  const recipient = recipients.find((r) => r.id === reply.recipientId) || null;
  const tone = recipient?.job_post_id ? matchScoreTone(recipient.match_score) : null;
  const postUrl = recipient ? firstUrl(recipient.source_url) : undefined;

  const history = recipient
    ? sentLog.filter((s) => sentKey(s.email, s.role) === sentKey(recipient.email, recipient.role))
    : [];
  // Every reply from this contact, including the one that was clicked to open this panel — merged with
  // `history` below into one chronological thread, not shown as two separate lists.
  const allReplies = recipient ? replies.filter((r) => r.recipientId === recipient.id) : [reply];
  const contactLabel = recipient?.email || reply.fromEmail;
  const thread: ThreadItem[] = [
    ...history.map((s) => ({ type: "sent" as const, at: s.sentAt, record: s })),
    ...allReplies.map((r) => ({ type: "received" as const, at: r.receivedAt || "", record: r })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  // Which SMTP account to send the reply from: the one that actually received it (correct once the
  // account cap changes from "one per user"), falling back to whichever verified account is available.
  const sendAccount =
    smtpAccounts.find((a) => a.id === reply.smtpAccountId) ||
    smtpAccounts.find((a) => a.isVerified && a.isActive) ||
    null;

  async function sendReply() {
    if (!userId) return;
    if (!sendAccount) {
      toast.error("No verified email account to send from.");
      return;
    }
    if (!replyBody.trim()) {
      toast.error("Write something before sending.");
      return;
    }
    setSending(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          fromName: sendAccount.fromName,
          email: sendAccount.email,
          fromEmail: sendAccount.fromEmail,
          appPassword: sendAccount.appPassword,
          host: sendAccount.host,
          port: sendAccount.port,
          toEmail: reply.fromEmail,
          subject: replySubject || "(No subject)",
          content: replyBody,
          // Threads the reply into the existing conversation instead of landing as a new, unrelated email.
          inReplyTo: reply.messageId,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(friendlySendError(data.error));
        return;
      }

      // Log it the same way every other send in the app is logged, so it shows up in this contact's
      // history here and in the Emails tab — an honest record of what actually went out, not just a
      // fire-and-forget action. Also clears any pending automated follow-up for this contact (addSentLog's
      // existing behavior on a "sent" status) — correct here too: they've now had a live exchange, a
      // further automated follow-up would be redundant.
      if (recipient) {
        await addSentLog(userId, {
          email: reply.fromEmail,
          role: recipient.role,
          title: recipient.title,
          subject: replySubject || "(No subject)",
          body: replyBody,
          status: "sent",
          sentAt: new Date().toISOString(),
          templateLabel: "Manual reply",
        });
      }

      toast.success("Reply sent.");
      setReplyBody("");
    } catch {
      toast.error("Network error sending reply.");
    } finally {
      setSending(false);
    }
  }

  return createPortal(
    <div className="side-panel-backdrop" role="presentation" onClick={onClose}>
      <div
        className="side-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="response-detail-panel-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="side-panel-head">
          <div style={{ minWidth: 0 }}>
            <h2 id="response-detail-panel-title" style={{ margin: 0, fontSize: "1rem", wordBreak: "break-all" }}>
              ↩ {reply.fromEmail}
            </h2>
            {recipient && (
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.35rem" }}>
                <span className="chip">{roleLabel(roleDefs, recipient.role)}</span>
                {recipient.title && <span className="hint compact" style={{ margin: 0 }}>{recipient.title}</span>}
              </div>
            )}
          </div>
          <button type="button" className="btn ghost" onClick={onClose}>Close</button>
        </div>

        <div className="side-panel-body">
          {(recipient?.title || recipient?.job_post_id || postUrl) && (
            <Section title="The job">
              {recipient?.title && <div style={{ fontSize: "0.9rem", fontWeight: 600 }}>{recipient.title}</div>}
              {tone && <span style={{ color: tone.color, fontWeight: 700, fontSize: "0.8rem" }}>{tone.label}</span>}
              {postUrl && (
                <a href={postUrl} target="_blank" rel="noopener noreferrer" className="btn ghost" style={{ alignSelf: "flex-start", fontSize: "0.75rem" }}>
                  View job post ↗
                </a>
              )}
            </Section>
          )}

          <Section title={`Conversation${thread.length > 0 ? ` (${thread.length})` : ""}`}>
            {thread.length === 0 ? (
              <p className="hint compact" style={{ margin: 0 }}>Nothing on record.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {thread.map((item, idx) => (
                  <ThreadMessage
                    key={`${item.type}-${idx}`}
                    item={item}
                    contactLabel={contactLabel}
                    showSubject={item.record.subject !== thread[idx - 1]?.record.subject}
                  />
                ))}
              </div>
            )}
          </Section>

          <Section title="Reply">
            <input
              type="text"
              value={replySubject}
              onChange={(e) => setReplySubject(e.target.value)}
              placeholder="Subject"
              style={{ padding: "0.4rem 0.5rem", border: "1px solid var(--line)", borderRadius: "8px", background: "var(--bg-elevated)", color: "var(--ink)", fontSize: "0.82rem" }}
            />
            <textarea
              value={replyBody}
              onChange={(e) => setReplyBody(e.target.value)}
              placeholder="Write your reply…"
              rows={6}
              style={{ padding: "0.5rem 0.6rem", border: "1px solid var(--line)", borderRadius: "8px", background: "var(--bg-elevated)", color: "var(--ink)", fontSize: "0.82rem", fontFamily: "inherit", resize: "vertical" }}
            />
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.5rem" }}>
              <span className="hint compact" style={{ margin: 0 }}>
                {sendAccount ? `Sending as ${sendAccount.fromEmail || sendAccount.email}` : "No verified email account connected"}
              </span>
              <button type="button" className="btn primary" onClick={sendReply} disabled={sending || !sendAccount}>
                {sending ? "Sending…" : "Send reply"}
              </button>
            </div>
          </Section>
        </div>
      </div>
    </div>,
    document.body
  );
}
