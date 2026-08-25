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
    </div>
  );
}
