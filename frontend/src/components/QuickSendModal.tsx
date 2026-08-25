"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import toast from "react-hot-toast";
import { supabase } from "@/lib/supabase";
import { addSentLog } from "@/lib/storage";
import { applyPlaceholders, hasUnresolvedPlaceholders, TEMPLATE_VARIABLES } from "@/lib/placeholders";
import { resolveRoleAttachments, describeFiles } from "@/lib/emailResolve";
import {
  roleLabel,
  type AiConfig,
  type AutomailConfig,
  type CandidateProfile,
  type Role,
  type RoleDef,
  type RoleTemplate,
  type SmtpAccount,
} from "@/lib/types";
import { AutoGrowTextarea } from "@/components/AutoGrowTextarea";

type Props = {
  userId: string | null;
  roleDefs: RoleDef[];
  templates: Record<Role, RoleTemplate[]>;
  automail: AutomailConfig;
  ai: AiConfig;
  smtpAccounts: SmtpAccount[];
  profile: CandidateProfile;
  sentTodayCount: number;
  onClose: () => void;
};

function uid() {
  return crypto.randomUUID();
}

// The three ways a Quick Send message can be composed (2026-08-25, operator ask — "the option should not
// rely on whatever the default option is. It should let me choose") — replaces the old implicit "auto"
// pick, which silently used a role's configured template with no explicit choice made. Now nothing is
// pre-filled until the candidate actively picks one of these:
//  - "write": blank subject/body, fully manual.
//  - "ai": AI drafts the whole email from scratch (candidate info + recipient details) via the same
//    /api/ai-enhance endpoint the old "Enhance" button used — that endpoint already handles an empty draft
//    gracefully ("write generically but do not invent specifics"), so no separate generation endpoint was
//    needed.
//  - "template": pick one of this role's saved templates from a dropdown; its content loads in, editable.
// Subject and body are editable in every mode now (2026-08-25, same ask — "allow me to edit the subject as
// well in the quick send"), not gated behind which mode is active.
type ComposeMode = "write" | "ai" | "template";

const COMPOSE_MODES: { value: ComposeMode; label: string; hint: string }[] = [
  { value: "write", label: "Write it myself", hint: "Start from a blank subject and body — full manual control." },
  { value: "ai", label: "Let AI write it", hint: "AI drafts the email from your candidate info — review before sending." },
  { value: "template", label: "Use a template", hint: "Pick one of this role's saved templates — still editable after." },
];

// The modal behind Dashboard's "+ Quick Send" button — one HR contact, its content composed via an explicit
// write/AI/template choice (see ComposeMode above), attachments resolved from the ROLE's own resume (see
// lib/emailResolve.ts's resolveRoleAttachments — same set a role always attaches, not per-template), sent
// immediately via /api/send (synchronous — see docs/architecture.md) rather than the delayed batch queue
// everything else in JAMS uses.
export function QuickSendModal({
  userId,
  roleDefs,
  templates,
  automail,
  ai,
  smtpAccounts,
  profile,
  sentTodayCount,
  onClose,
}: Props) {
  const [hrName, setHrName] = useState("");
  const [hrEmail, setHrEmail] = useState("");
  const [hrPhone, setHrPhone] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [role, setRole] = useState<Role>(roleDefs[0]?.key || "fullstack");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [enhancing, setEnhancing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const roleTemplates = useMemo(() => templates[role] || [], [templates, role]);
  const roleDef = useMemo(() => roleDefs.find((d) => d.key === role) || null, [roleDefs, role]);

  const [composeMode, setComposeMode] = useState<ComposeMode>("write");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  const selectedTemplate: RoleTemplate | null = roleTemplates.find((t) => t.id === selectedTemplateId) || null;

  // Switching compose mode starts that mode's content fresh — the three are meant as distinct starting
  // points, not stacked on top of each other's leftover draft.
  useEffect(() => {
    setSelectedTemplateId(null);
    setSubject("");
    setBody("");
  }, [composeMode]);

  // A different role's template ids don't apply, and previously-picked content may no longer make sense —
  // clear the template pick when the role changes (only matters in "template" mode; "write"/"ai" drafts are
  // left alone since they're not tied to a specific role's templates).
  useEffect(() => {
    setSelectedTemplateId(null);
    if (composeMode === "template") {
      setSubject("");
      setBody("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  function selectTemplate(id: string) {
    setSelectedTemplateId(id);
    const t = roleTemplates.find((x) => x.id === id);
    if (t) {
      setSubject(t.subject);
      setBody(t.content);
    }
  }

  const aiReady = ai.enabled;

  const roleFiles = useMemo(() => resolveRoleAttachments(roleDef, profile).all, [roleDef, profile]);

  function insertVariable(token: string) {
    if (!token) return;
    setBody((b) => (b && !b.endsWith("\n") && !b.endsWith(" ") ? `${b} ${token}` : `${b}${token}`));
  }

  // Backs "Let AI write it" — also doubles as a "polish this draft" call when subject/body are already
  // non-empty (the underlying endpoint handles both: "if a draft is already provided, preserve its intent
  // ... polish"), so the same handler serves both the initial "Generate" click and a later "Regenerate".
  async function enhance() {
    if (!aiReady) {
      toast.error("Enable AI Personalization on the AI tab first.");
      return;
    }
    setEnhancing(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/ai-enhance", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
        },
        body: JSON.stringify({
          draftSubject: subject,
          draftBody: body,
          candidateInfo: automail.candidateInfo,
          profile,
          recipientName: hrName,
          recipientRole: roleLabel(roleDefs, role),
          recipientJobTitle: jobTitle,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "AI enhancement failed.");
      setSubject(data.subject);
      setBody(data.body);
      toast.success("Draft ready — review before sending.");
    } catch (e: any) {
      toast.error(e?.message || "AI enhancement failed.");
    } finally {
      setEnhancing(false);
    }
  }

  async function submit(send: boolean) {
    const email = hrEmail.trim().toLowerCase();
    if (!email) {
      toast.error("Enter the HR contact's email.");
      return;
    }
    if (!userId) return;

    let finalSubject = subject;
    let finalBody = body;

    if (send) {
      if (sentTodayCount >= automail.dailyLimit) {
        toast.error(`Daily limit of ${automail.dailyLimit} reached.`);
        return;
      }
      const account = smtpAccounts.find((a) => a.isVerified && a.isActive);
      if (!account) {
        toast.error("Add and verify at least one SMTP account first.");
        return;
      }

      finalSubject = applyPlaceholders(finalSubject, { email, title: jobTitle, author_name: hrName }, profile);
      finalBody = applyPlaceholders(finalBody, { email, title: jobTitle, author_name: hrName }, profile);
      if (!finalSubject.trim() || !finalBody.trim()) {
        toast.error("Subject and body can't be empty — use a template, write one, or let AI write it first.");
        return;
      }
      if (hasUnresolvedPlaceholders(finalSubject) || hasUnresolvedPlaceholders(finalBody)) {
        toast.error("A {{variable}} in the message is still unresolved — fill it in or remove it before sending.");
        return;
      }

      setSaving(true);
      try {
        const newId = uid();
        const { error: insertError } = await supabase.from("automailsend_recipients").insert({
          id: newId,
          user_id: userId,
          email,
          phone: hrPhone.trim() || null,
          role,
          title: jobTitle.trim(),
          author_name: hrName.trim() || null,
          source: "manual",
          status: "pending",
        });
        if (insertError) throw insertError;

        const sendRes = await fetch("/api/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fromName: account.fromName,
            email: account.email,
            fromEmail: account.fromEmail,
            appPassword: account.appPassword,
            host: account.host,
            port: account.port,
            toEmail: email,
            subject: finalSubject,
            content: finalBody,
            attachments: roleFiles.map((f) => ({ filename: f.name, path: f.url, contentType: f.type })),
          }),
        });
        const sendData = await sendRes.json();

        await addSentLog(userId, {
          email,
          role,
          title: jobTitle.trim(),
          subject: finalSubject,
          body: finalBody,
          status: sendRes.ok && sendData.success ? "sent" : "failed",
          error: sendData.error,
          sentAt: new Date().toISOString(),
          templateLabel: composeMode === "template" ? selectedTemplate?.label : composeMode === "ai" ? "AI-written" : "Custom",
          resumeLabel: describeFiles(roleFiles),
        });

        if (sendRes.ok && sendData.success) {
          toast.success(`Sent to ${email}.`);
        } else {
          toast.error(`Contact added, but sending failed: ${sendData.error || "unknown error"}`);
        }
        onClose();
      } catch (e: any) {
        toast.error(e?.message || "Failed to send.");
      } finally {
        setSaving(false);
      }
      return;
    }

    // Add without sending
    setSaving(true);
    try {
      const { error: insertError } = await supabase.from("automailsend_recipients").insert({
        id: uid(),
        user_id: userId,
        email,
        phone: hrPhone.trim() || null,
        role,
        title: jobTitle.trim(),
        author_name: hrName.trim() || null,
        source: "manual",
        status: "pending",
      });
      if (insertError) throw insertError;
      toast.success("Contact added.");
      onClose();
    } catch (e: any) {
      toast.error(e?.message || "Failed to add contact.");
    } finally {
      setSaving(false);
    }
  }

  if (!mounted) return null;

  return createPortal(
    <div className="modal-backdrop" role="presentation" onClick={onClose} style={{ zIndex: 99999 }}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="quick-send-modal-title"
        style={{ width: "min(680px, 100%)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="quick-send-modal-title">Quick Send</h2>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        </div>
        <div className="modal-body">
          <div className="grid-2">
            <label className="field">
              <span>HR name</span>
              <input type="text" value={hrName} onChange={(e) => setHrName(e.target.value)} placeholder="e.g. Jane Doe" disabled={saving} />
            </label>
            <label className="field">
              <span>Job title / position (optional)</span>
              <input type="text" value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} placeholder="e.g. Backend Developer" disabled={saving} />
            </label>
            <label className="field">
              <span>HR email *</span>
              <input type="email" value={hrEmail} onChange={(e) => setHrEmail(e.target.value)} placeholder="hr@company.com" disabled={saving} />
            </label>
            <label className="field">
              <span>HR phone (optional)</span>
              <input type="text" value={hrPhone} onChange={(e) => setHrPhone(e.target.value)} placeholder="+1234567890" disabled={saving} />
            </label>
            <label className="field">
              <span>Role</span>
              <select value={role} onChange={(e) => setRole(e.target.value as Role)} disabled={saving}>
                {roleDefs.map((def) => <option key={def.key} value={def.key}>{def.label}</option>)}
              </select>
            </label>
          </div>

          <div className="template-card single" style={{ padding: "1rem" }}>
            <h3 style={{ margin: "0 0 0.6rem", fontSize: "0.9rem" }}>How do you want to write this email?</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
              {COMPOSE_MODES.map((m) => (
                <label key={m.value} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="composeMode"
                    checked={composeMode === m.value}
                    onChange={() => setComposeMode(m.value)}
                    disabled={saving}
                    style={{ marginTop: "0.25rem" }}
                  />
                  <span>
                    <strong style={{ fontSize: "0.82rem" }}>{m.label}</strong>
                    <div className="hint compact" style={{ margin: 0 }}>{m.hint}</div>
                  </span>
                </label>
              ))}
            </div>

            {composeMode === "template" && (
              <div style={{ marginTop: "0.75rem" }}>
                {roleTemplates.length > 0 ? (
                  <label className="field" style={{ margin: 0 }}>
                    <span>Template</span>
                    <select value={selectedTemplateId || ""} onChange={(e) => selectTemplate(e.target.value)} disabled={saving}>
                      <option value="" disabled>Choose a template…</option>
                      {roleTemplates.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                  </label>
                ) : (
                  <p className="hint compact" style={{ margin: 0 }}>
                    No templates saved for &quot;{roleLabel(roleDefs, role)}&quot; yet — add one on the Templates tab, or pick another option above.
                  </p>
                )}
              </div>
            )}

            {composeMode === "ai" && (
              <div style={{ marginTop: "0.75rem", display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
                <button type="button" className="btn primary" onClick={enhance} disabled={saving || enhancing || !aiReady}>
                  {enhancing ? "Generating…" : subject || body ? "🔄 Regenerate" : "✨ Generate with AI"}
                </button>
                {!aiReady && <span className="hint compact">Enable AI Personalization on the AI tab first.</span>}
              </div>
            )}
          </div>

          <label className="field">
            <span>Subject</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Application for {{title}}"
              disabled={saving}
            />
          </label>

          <label className="field">
            <span>Body</span>
            <AutoGrowTextarea
              value={body}
              maxHeight={280}
              onChange={(e) => setBody(e.target.value)}
              placeholder={composeMode === "ai" ? "Click Generate with AI above, or write it yourself…" : "Write your message…"}
              disabled={saving}
            />
          </label>

          <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
            <select
              value=""
              onChange={(e) => insertVariable(e.target.value)}
              disabled={saving}
              style={{ fontSize: "0.8rem" }}
            >
              <option value="">Insert variable…</option>
              {TEMPLATE_VARIABLES.map((v) => (
                <option key={v.token} value={v.token}>{v.token} — {v.label}</option>
              ))}
            </select>
            {roleFiles.length > 0 && (
              <span className="hint compact">📎 {roleFiles.length} attachment{roleFiles.length === 1 ? "" : "s"} from this role will be included</span>
            )}
          </div>
        </div>

        <hr style={{ border: "0", borderTop: "1px solid var(--line)", margin: "1rem 0" }} />

        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.6rem" }}>
          <button type="button" className="btn" onClick={() => submit(false)} disabled={saving}>
            Add without sending
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => submit(true)}
            disabled={saving}
          >
            {saving ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
