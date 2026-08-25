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

// "auto" = this role's configured manual template (RoleDef.selectedTemplateId), or its first template if
// none is explicitly selected — deterministic, no re-roll (2026-08-19: randomization removed). A role set
// to "Let AI choose" still falls back to this deterministic behavior here, since that mode needs a
// scraped job post's context to work from and Quick Send is a one-off hand-added HR contact with no such
// context — see the hint text below the picker. "custom" = write it yourself. Otherwise, a specific
// template's id — its exact content, editable, and guaranteed to be what sends.
type TemplatePick = "auto" | "custom" | string;

// The modal behind JamsTab's "+ Quick Send" button — one HR contact, its content sourced from the role's
// template library (auto/specific/custom), attachments resolved from the ROLE's own resume + additional
// files (see lib/emailResolve.ts's resolveRoleAttachments — same set a role always attaches, not
// per-template), optionally AI-polished, sent immediately via /api/send (synchronous — see
// docs/architecture.md) rather than the delayed batch queue everything else in JAMS uses.
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

  const [templatePick, setTemplatePick] = useState<TemplatePick>("auto");

  // Reset the pick (and draft) when the role changes — a different role's template ids don't apply.
  useEffect(() => {
    setTemplatePick(roleTemplates.length > 0 ? "auto" : "custom");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);

  const autoTemplate: RoleTemplate | null =
    roleTemplates.find((t) => t.id === roleDef?.selectedTemplateId) || roleTemplates[0] || null;

  const previewTemplate: RoleTemplate | null =
    templatePick === "custom" ? null : templatePick === "auto" ? autoTemplate : roleTemplates.find((t) => t.id === templatePick) || null;

  const fieldsEditable = templatePick !== "auto";

  // Load the picked template's content into the editable draft whenever the pick changes (auto shows a
  // read-only preview; a specific template's content is editable and IS what sends).
  useEffect(() => {
    if (templatePick === "custom") {
      setSubject("");
      setBody("");
    } else if (previewTemplate) {
      setSubject(previewTemplate.subject);
      setBody(previewTemplate.content);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templatePick, role]);

  const aiReady = ai.enabled;

  const roleFiles = useMemo(() => resolveRoleAttachments(roleDef, profile).all, [roleDef, profile]);

  function insertVariable(token: string) {
    if (!token) return;
    setBody((b) => (b && !b.endsWith("\n") && !b.endsWith(" ") ? `${b} ${token}` : `${b}${token}`));
  }

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
      toast.success("Draft enhanced — review before sending.");
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

      // No randomization to re-roll any more (2026-08-19) — "auto" is deterministic, so the read-only
      // preview already IS what sends.
      const usedTemplate = templatePick === "custom" ? null : previewTemplate;

      finalSubject = applyPlaceholders(finalSubject, { email, title: jobTitle, author_name: hrName }, profile);
      finalBody = applyPlaceholders(finalBody, { email, title: jobTitle, author_name: hrName }, profile);
      if (!finalSubject.trim() || !finalBody.trim()) {
        toast.error("Subject and body can't be empty — use a template, write one, or enhance with AI first.");
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
          templateLabel: templatePick === "custom" ? "Custom" : usedTemplate?.label,
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

          <label className="field">
            <span>Template</span>
            <select value={templatePick} onChange={(e) => setTemplatePick(e.target.value)} disabled={saving}>
              {roleTemplates.length > 0 && <option value="auto">Auto (this role&apos;s template)</option>}
              <option value="custom">Custom — write it yourself</option>
              {roleTemplates.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </label>

          {templatePick === "auto" && (
            <p className="hint compact">
              {autoTemplate
                ? roleDef && (roleDef.emailSendMode === "ai-select" || roleDef.emailSendMode === "ai-write")
                  ? `This role is set to "${roleDef.emailSendMode === "ai-select" ? "Let AI choose" : "Let AI write it"}" for automated sends — Quick Send has no job post for AI to work from, so it uses "${autoTemplate.label}" directly. Pick a specific template above to customize the wording, or Custom to write your own.`
                  : `Will use "${autoTemplate.label}" — pick a specific template above to customize the wording, or Custom to write your own.`
                : "No template selected for this role yet — pick one above, or Custom to write your own."}
            </p>
          )}

          <label className="field">
            <span>Subject</span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Application for {{title}}"
              disabled={saving || !fieldsEditable}
            />
          </label>

          <label className="field">
            <span>Body</span>
            <AutoGrowTextarea
              value={body}
              maxHeight={280}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Write your message, or use a template / AI enhance below…"
              disabled={saving || !fieldsEditable}
            />
          </label>

          <div style={{ display: "flex", gap: "0.6rem", alignItems: "center", flexWrap: "wrap" }}>
            <select
              value=""
              onChange={(e) => insertVariable(e.target.value)}
              disabled={saving || !fieldsEditable}
              style={{ fontSize: "0.8rem" }}
            >
              <option value="">Insert variable…</option>
              {TEMPLATE_VARIABLES.map((v) => (
                <option key={v.token} value={v.token}>{v.token} — {v.label}</option>
              ))}
            </select>
            <button
              type="button"
              className="btn ghost"
              style={{ color: "var(--accent)" }}
              onClick={enhance}
              disabled={saving || enhancing || !aiReady || !fieldsEditable}
              title={!fieldsEditable ? "Pick a specific template or Custom to enhance a draft" : aiReady ? "Polish the current draft with AI" : "Enable AI Personalization on the AI tab first"}
            >
              {enhancing ? "Enhancing…" : "✨ Enhance with AI"}
            </button>
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
