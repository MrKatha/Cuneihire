"use client";

import { useMemo } from "react";
import {
  roleLabel,
  EMAIL_SEND_MODES,
  type Recipient,
  type Role,
  type RoleDef,
  type RoleTemplate,
} from "@/lib/types";

type Props = {
  recipients: Recipient[];
  templates: Record<Role, RoleTemplate[]>;
  roleDefs: RoleDef[];
  activeRole: Role;
  onActiveRoleChange: (role: Role) => void;
  onUpdateRoleRules: (id: string, patch: Partial<RoleDef>) => void;
};

// The Email Templates tab's "Configuration" sub-tab (2026-08-20, operator ask — mirrors the Resumes tab's
// own two-sub-tab split, Builder/Library). Purely "how does this role send" — which template(s) themselves live on
// the sibling "Templates" sub-tab (RoleTemplates.tsx); this one just owns RoleDef.emailSendMode per role,
// via the same shared `activeRole` state so switching role here stays in sync with Templates/Roles.
export function EmailConfigTab({ recipients, templates, roleDefs, activeRole, onActiveRoleChange, onUpdateRoleRules }: Props) {
  const counts = useMemo(() => {
    const map: Record<Role, number> = {};
    roleDefs.forEach((def) => { map[def.key] = 0; });
    recipients.forEach((r) => { map[r.role] = (map[r.role] || 0) + 1; });
    return map;
  }, [recipients, roleDefs]);

  const activeRoleDef = roleDefs.find((d) => d.key === activeRole) || null;
  const roleTemplates = templates[activeRole] || [];

  function handleModeChange(mode: RoleDef["emailSendMode"]) {
    if (!activeRoleDef) return;
    const patch: Partial<RoleDef> = { emailSendMode: mode };
    if (mode === "manual" && !roleTemplates.some((t) => t.id === activeRoleDef.selectedTemplateId) && roleTemplates.length > 0) {
      patch.selectedTemplateId = roleTemplates[0].id;
    }
    onUpdateRoleRules(activeRoleDef.id, patch);
  }

  // Follow-ups (2026-08-31, MVP push) — independent of emailSendMode above: whichever mode sent the
  // initial email, a follow-up schedule can still run on top of it. null/0 = off for this role (the
  // default — see followUpIntervalDays's comment in types.ts).
  function handleFollowUpIntervalChange(raw: string) {
    if (!activeRoleDef) return;
    const n = raw.trim() === "" ? null : Math.max(1, parseInt(raw, 10) || 0) || null;
    onUpdateRoleRules(activeRoleDef.id, { followUpIntervalDays: n });
  }

  function handleFollowUpSlotChange(slot: 1 | 2 | 3, templateId: string) {
    if (!activeRoleDef) return;
    const field = (`followUpTemplate${slot}Id`) as "followUpTemplate1Id" | "followUpTemplate2Id" | "followUpTemplate3Id";
    onUpdateRoleRules(activeRoleDef.id, { [field]: templateId || null });
  }

  if (roleDefs.length === 0) {
    return (
      <p className="hint">
        No roles yet — add one on <strong>Roles</strong> first, then come back here to set how it sends.
      </p>
    );
  }

  return (
    <div className="panel-body">
      <div className="role-tabs" role="tablist">
        {roleDefs.map((def) => (
          <button
            key={def.key}
            type="button"
            role="tab"
            aria-selected={activeRole === def.key}
            className={`role-tab${activeRole === def.key ? " active" : ""}${counts[def.key] > 0 ? " has-recipients" : ""}`}
            onClick={() => onActiveRoleChange(def.key)}
          >
            <span>{def.label}</span>
            <span className="role-tab-count">{counts[def.key] || 0}</span>
          </button>
        ))}
      </div>

      {activeRoleDef && (
        <div className="template-card single" style={{ marginTop: "1rem" }}>
          <div className="template-head">
            <h3>How does &quot;{roleLabel(roleDefs, activeRole)}&quot; send emails?</h3>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {EMAIL_SEND_MODES.map((m) => (
              <label key={m.value} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", cursor: "pointer" }}>
                <input
                  type="radio"
                  name="emailSendMode"
                  checked={activeRoleDef.emailSendMode === m.value}
                  onChange={() => handleModeChange(m.value)}
                  style={{ marginTop: "0.25rem" }}
                />
                <span>
                  <strong style={{ fontSize: "0.82rem" }}>{m.label}</strong>
                  <div className="hint compact" style={{ margin: 0 }}>{m.hint}</div>
                </span>
              </label>
            ))}
          </div>
          {activeRoleDef.emailSendMode === "ai-write" && (
            <p className="hint compact" style={{ marginTop: "0.6rem" }}>
              No template needed for this role — AI writes the whole email from your{" "}
              <strong>candidate info</strong> (My Profile) and the job post. The attachment still comes
              from this role&apos;s resume, set on the <strong>Resumes</strong> tab&apos;s Builder
              sub-tab.
            </p>
          )}
        </div>
      )}

      {activeRoleDef && (
        <div className="template-card single" style={{ marginTop: "1rem" }}>
          <div className="template-head">
            <h3>Follow-ups for &quot;{roleLabel(roleDefs, activeRole)}&quot;</h3>
          </div>
          <label className="field" style={{ maxWidth: "280px" }}>
            <span>Wait between follow-ups (days)</span>
            <input
              type="number"
              min={1}
              placeholder="Off"
              value={activeRoleDef.followUpIntervalDays ?? ""}
              onChange={(e) => handleFollowUpIntervalChange(e.target.value)}
            />
          </label>
          <p className="hint compact" style={{ margin: "0.4rem 0 0" }}>
            Leave blank to turn follow-ups off for this role. When set, up to 3 follow-ups go out on this
            interval to any recipient who hasn&apos;t replied. Each costs an app credit; an AI-written one
            also costs an AI credit.
          </p>
          {activeRoleDef.followUpIntervalDays != null && (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem", marginTop: "0.75rem" }}>
              {([1, 2, 3] as const).map((slot) => {
                const field = (`followUpTemplate${slot}Id`) as "followUpTemplate1Id" | "followUpTemplate2Id" | "followUpTemplate3Id";
                return (
                  <label key={slot} className="field">
                    <span>Follow-up {slot}</span>
                    <select value={activeRoleDef[field] ?? ""} onChange={(e) => handleFollowUpSlotChange(slot, e.target.value)}>
                      <option value="">AI writes this one</option>
                      {roleTemplates.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
