"use client";

import { useEffect, useMemo, useState } from "react";
import { AutoGrowTextarea } from "@/components/AutoGrowTextarea";
import { HelpTooltip } from "@/components/HelpTooltip";
import {
  roleLabel,
  type Recipient,
  type Role,
  type RoleDef,
  type RoleTemplate,
} from "@/lib/types";
import toast from "react-hot-toast";

type Props = {
  recipients: Recipient[];
  templates: Record<Role, RoleTemplate[]>;
  activeRole: Role;
  onActiveRoleChange: (role: Role) => void;
  onSave: (role: Role, template: Partial<RoleTemplate> & { id?: string }) => Promise<RoleTemplate | null>;
  onDelete: (role: Role, id: string) => Promise<void>;
  roleDefs: RoleDef[];
  onUpdateRoleRules: (id: string, patch: Partial<RoleDef>) => void;
};

// The Email Templates tab's "Templates" sub-tab (2026-08-19: randomization removed — see
// docs/architecture.md's "Email Templates redesign" section; 2026-08-20: split into Templates/
// Configuration sub-tabs, mirroring the Resumes tab's own two-sub-tab split). Purely template wording
// now — the per-role send mode (manual / "let AI choose" / "let AI write it") lives on the sibling
// Configuration sub-tab (EmailConfigTab.tsx), and the attachment (the role's one resume — "additional
// files" retired 2026-08-20) lives on the ROLE, set on the Resumes tab's Builder sub-tab (2026-08-20,
// Resume Builder redesign — moved there from a "Configuration" sub-tab that's since been renamed
// "Library" and no longer does per-role authoring at all; see docs/architecture.md).
// List + detail editor per role, explicit Save for the wording, immediate-save for the template-select
// radio.
export function RoleTemplates({
  recipients,
  templates,
  activeRole,
  onActiveRoleChange,
  onSave,
  onDelete,
  roleDefs,
  onUpdateRoleRules,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);

  const counts = useMemo(() => {
    const map: Record<Role, number> = {};
    roleDefs.forEach((def) => { map[def.key] = 0; });
    recipients.forEach((r) => {
      map[r.role] = (map[r.role] || 0) + 1;
    });
    return map;
  }, [recipients, roleDefs]);

  const activeRoleDef = roleDefs.find((d) => d.key === activeRole) || null;
  const roleTemplates = templates[activeRole] || [];
  const selected =
    roleTemplates.find((t) => t.id === selectedId) ||
    roleTemplates.find((t) => t.id === activeRoleDef?.selectedTemplateId) ||
    roleTemplates[0] ||
    null;

  // Draft fields for the selected template — explicit "Save changes" rather than a network call per
  // keystroke.
  const [draftLabel, setDraftLabel] = useState("");
  const [draftSubject, setDraftSubject] = useState("");
  const [draftContent, setDraftContent] = useState("");

  useEffect(() => {
    setDraftLabel(selected?.label || "");
    setDraftSubject(selected?.subject || "");
    setDraftContent(selected?.content || "");
  }, [selected?.id]);

  const dirty =
    !!selected &&
    (draftLabel !== selected.label || draftSubject !== selected.subject || draftContent !== selected.content);

  function handleSelectTemplate(templateId: string) {
    if (!activeRoleDef) return;
    onUpdateRoleRules(activeRoleDef.id, { selectedTemplateId: templateId });
  }

  async function handleNewTemplate() {
    setCreating(true);
    try {
      const saved = await onSave(activeRole, {
        label: `Template ${roleTemplates.length + 1}`,
        subject: "",
        content: "",
        files: [],
      });
      if (saved) {
        setSelectedId(saved.id);
        // First template for a manual-mode role with nothing selected yet — pick it automatically so
        // the role isn't silently unsendable.
        if (activeRoleDef?.emailSendMode === "manual" && !activeRoleDef.selectedTemplateId) {
          onUpdateRoleRules(activeRoleDef.id, { selectedTemplateId: saved.id });
        }
        toast.success("Template created.");
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleDuplicate(t: RoleTemplate) {
    const saved = await onSave(activeRole, {
      label: `${t.label} copy`,
      subject: t.subject,
      content: t.content,
      files: [],
    });
    if (saved) {
      setSelectedId(saved.id);
      toast.success("Template duplicated.");
    }
  }

  async function handleDeleteTemplate(t: RoleTemplate) {
    if (!window.confirm(`Delete template "${t.label}"?`)) return;
    await onDelete(activeRole, t.id);
    if (selectedId === t.id) setSelectedId(null);
    // Deleting the role's manually-selected template reverts to "none selected" (unknown isn't a fail —
    // same as the backend workers' resolution logic), not left dangling on a stale id.
    if (activeRoleDef?.selectedTemplateId === t.id) {
      onUpdateRoleRules(activeRoleDef.id, { selectedTemplateId: null });
    }
    toast.success("Template deleted.");
  }

  async function handleSaveDraft() {
    if (!selected) return;
    setSaving(true);
    try {
      await onSave(activeRole, {
        id: selected.id,
        label: draftLabel.trim() || "Untitled",
        subject: draftSubject,
        content: draftContent,
      });
      toast.success("Template saved.");
    } finally {
      setSaving(false);
    }
  }

  // No roles yet — the candidate hasn't added one on Roles. Don't let "+ New" fall through to the
  // unmatched `activeTemplateRole` placeholder and save a template under a role that doesn't exist.
  if (roleDefs.length === 0) {
    return (
      <p className="hint">
        No roles yet — add one on <strong>Roles</strong> first, then come back here to write templates
        for it.
      </p>
    );
  }

  return (
    <div className="panel-body">
      <p className="hint compact" style={{ display: "flex", alignItems: "center", gap: "0.3rem" }}>
        Manage roles and keywords on <strong>Roles</strong>, attachments on <strong>Resumes</strong>,
        send mode on this tab&apos;s <strong>Configuration</strong> sub-tab · 8 variables available
        <HelpTooltip
          title="Template Variables"
          content={
            <>
              <p><strong>About the job</strong> (best-effort, blank if unknown): {"{{title}}"} {"{{name}}"} {"{{email}}"}</p>
              <p><strong>About you</strong> (set on the Profile page): {"{{candidate_name}}"} {"{{candidate_email}}"} {"{{candidate_phone}}"} {"{{candidate_portfolio}}"} {"{{candidate_resume_link}}"}</p>
              <p>An email is never sent with one of these left unfilled — it&apos;s blocked instead.</p>
            </>
          }
        />
      </p>

      <div className="role-tabs" role="tablist">
        {roleDefs.map((def) => (
          <button
            key={def.key}
            type="button"
            role="tab"
            aria-selected={activeRole === def.key}
            className={`role-tab${activeRole === def.key ? " active" : ""}${
              counts[def.key] > 0 ? " has-recipients" : ""
            }`}
            onClick={() => {
              onActiveRoleChange(def.key);
              setSelectedId(null);
            }}
          >
            <span>{def.label}</span>
            <span className="role-tab-count">{counts[def.key] || 0}</span>
          </button>
        ))}
      </div>

      <div style={{ display: "flex", gap: "1rem", alignItems: "flex-start", flexWrap: "wrap", marginTop: "1rem" }}>
          <div style={{ flex: "0 0 260px", minWidth: "220px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
              <span className="hint compact" style={{ margin: 0 }}>
                {roleTemplates.length} template{roleTemplates.length === 1 ? "" : "s"}
              </span>
              <button type="button" className="btn" style={{ fontSize: "0.75rem" }} onClick={handleNewTemplate} disabled={creating}>
                + New
              </button>
            </div>
            {roleTemplates.length === 0 ? (
              <p className="hint compact">
                No templates yet for {roleLabel(roleDefs, activeRole)} — add one to start sending to this role.
              </p>
            ) : (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: "0.4rem" }}>
                {roleTemplates.map((t) => (
                  <li
                    key={t.id}
                    onClick={() => setSelectedId(t.id)}
                    style={{
                      border: `1px solid ${selected?.id === t.id ? "var(--accent)" : "var(--line)"}`,
                      borderRadius: "8px",
                      padding: "0.5rem 0.6rem",
                      cursor: "pointer",
                      background: selected?.id === t.id ? "color-mix(in srgb, var(--accent) 8%, transparent)" : "var(--bg-elevated)",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.4rem" }}>
                      <strong style={{ fontSize: "0.85rem" }}>{t.label}</strong>
                      {activeRoleDef?.selectedTemplateId === t.id && (
                        <span className="badge ok" style={{ fontSize: "0.65rem" }}>In use</span>
                      )}
                    </div>
                    <div className="hint compact" style={{ margin: "0.15rem 0 0" }}>{t.subject || "(no subject)"}</div>
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", marginTop: "0.35rem", fontSize: "0.7rem", flexWrap: "wrap" }}>
                      {activeRoleDef?.emailSendMode === "manual" && (
                        <label style={{ display: "flex", alignItems: "center", gap: "0.25rem", cursor: "pointer" }} onClick={(e) => e.stopPropagation()}>
                          <input type="radio" name="selectedTemplate" checked={activeRoleDef.selectedTemplateId === t.id} onChange={() => handleSelectTemplate(t.id)} />
                          Use this template
                        </label>
                      )}
                      <button type="button" className="btn ghost" style={{ fontSize: "0.68rem", padding: "0.1rem 0.3rem" }} onClick={(e) => { e.stopPropagation(); handleDuplicate(t); }}>
                        Duplicate
                      </button>
                      <button type="button" className="btn ghost danger" style={{ fontSize: "0.68rem", padding: "0.1rem 0.3rem", marginLeft: "auto" }} onClick={(e) => { e.stopPropagation(); handleDeleteTemplate(t); }}>
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="scroll-area template-editor" style={{ flex: "1 1 380px", minWidth: "280px" }}>
            {!selected ? (
              <p className="hint">Select or create a template to edit it.</p>
            ) : (
              <div className="template-card single">
                <div className="template-head">
                  <h3>{roleLabel(roleDefs, activeRole)}</h3>
                  <span className="chip">
                    {counts[activeRole] || 0} recipient
                    {(counts[activeRole] || 0) === 1 ? "" : "s"}
                  </span>
                </div>

                <label className="field">
                  <span>Template name</span>
                  <input type="text" value={draftLabel} onChange={(e) => setDraftLabel(e.target.value)} placeholder="e.g. Casual pitch" />
                </label>

                <label className="field">
                  <span>Subject</span>
                  <input
                    id="tour-templates-subject"
                    type="text"
                    value={draftSubject}
                    onChange={(e) => setDraftSubject(e.target.value)}
                    placeholder={`${roleLabel(roleDefs, activeRole)} subject`}
                  />
                </label>

                <label className="field stretch">
                  <span>Content</span>
                  <AutoGrowTextarea
                    id="tour-templates-body"
                    className="textarea-content"
                    value={draftContent}
                    maxHeight={320}
                    onChange={(e) => setDraftContent(e.target.value)}
                    placeholder="Email body for this role…"
                  />
                </label>

                <button type="button" className="btn primary" onClick={handleSaveDraft} disabled={saving || !dirty}>
                  {saving ? "Saving…" : dirty ? "Save changes" : "Saved"}
                </button>

                <p className="hint compact" style={{ marginTop: "0.75rem" }}>
                  The resume for &quot;{roleLabel(roleDefs, activeRole)}&quot; is set on the{" "}
                  <strong>Resumes</strong> tab&apos;s Builder sub-tab — the same one applies to every
                  template for this role.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
  );
}
