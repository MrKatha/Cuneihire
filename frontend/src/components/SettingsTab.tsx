"use client";

import { EmailConfigTab } from "./EmailConfigTab";
import {
  autoFetchLinkedInConnected,
  type AutoFetchConfig,
  type CandidateProfile,
  type Recipient,
  type Role,
  type RoleDef,
  type RoleTemplate,
  type SmtpAccount,
} from "@/lib/types";

type Props = {
  smtpAccounts: SmtpAccount[];
  autoFetch: AutoFetchConfig;
  onOpenSmtp: () => void;
  onOpenAutoFetch: () => void;
  // "Who writes his email" (2026-08-25, operator ask) — reuses the existing per-role manual/"let AI
  // choose"/"let AI write it" picker (EmailConfigTab.tsx) rather than inventing a second one; the template
  // library itself stays separate, on the Email Templates tab, exactly as the operator asked ("a template
  // library will be separate, as it is right now, for both email and resumes").
  recipients: Recipient[];
  templates: Record<Role, RoleTemplate[]>;
  roleDefs: RoleDef[];
  activeRole: Role;
  onActiveRoleChange: (role: Role) => void;
  onUpdateRoleRules: (id: string, patch: Partial<RoleDef>) => void;
  // Resume card is a plain pointer only — no AI-tailoring controls here. That's the "Resume for AI"
  // feature the operator described in detail and explicitly deferred ("do not build this right now... add
  // it to the phase after we build the admin portal").
  profile: CandidateProfile;
  onGoToResumes: () => void;
  newPassword: string;
  onNewPasswordChange: (value: string) => void;
  passwordLoading: boolean;
  onPasswordChangeSubmit: (e: React.FormEvent) => void;
};

function Card({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "12px", padding: "1.25rem" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.75rem", gap: "0.5rem" }}>
        <h3 style={{ margin: 0, fontSize: "1rem" }}>{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

// A flat grid of config cards (2026-08-25, operator ask — "a similar layout to the dashboard... the SMTP
// account section where you can see our SMTPs. When I click on Add it will give me the same pop-up as we
// have right now. Same goes for LinkedIn"). Not tabbed — Dashboard/JamsOverviewTab.tsx isn't either, it's
// one page of cards, so this matches that same visual language directly rather than adding its own nav.
// Automation on/off + daily limit live on JamsOverviewTab instead of here ("the toggle for the automation
// should obviously be in our dashboard" — operator, earlier the same day) — this page is purely
// SMTP/LinkedIn/email-authorship/resume-pointer/account, nothing that starts or stops sending.
export function SettingsTab({
  smtpAccounts,
  autoFetch,
  onOpenSmtp,
  onOpenAutoFetch,
  recipients,
  templates,
  roleDefs,
  activeRole,
  onActiveRoleChange,
  onUpdateRoleRules,
  profile,
  onGoToResumes,
  newPassword,
  onNewPasswordChange,
  passwordLoading,
  onPasswordChangeSubmit,
}: Props) {
  const readyAccounts = smtpAccounts.filter((a) => a.isVerified && a.isActive);
  const linkedInConnected = autoFetchLinkedInConnected(autoFetch);
  const defaultResume = profile.files.find((f) => f.id === profile.globalResumeId) || null;

  return (
    <div className="panel flex-col gap-4">
      <h2 className="panel-title">Settings</h2>

      <Card
        title="SMTP Accounts"
        action={<button type="button" className="btn primary small" onClick={onOpenSmtp}>{smtpAccounts.length === 0 ? "Add" : "Manage"}</button>}
      >
        {smtpAccounts.length === 0 ? (
          <p className="hint compact">No mailbox connected yet — add one to start sending.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.4rem" }}>
            {smtpAccounts.map((a) => (
              <li key={a.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "0.85rem" }}>
                <span>{a.email}</span>
                <span className={a.isVerified && a.isActive ? "badge ok" : "badge warn"}>
                  {a.isVerified && a.isActive ? "Ready" : a.isVerified ? "Inactive" : "Unverified"}
                </span>
              </li>
            ))}
          </ul>
        )}
        {smtpAccounts.length > 0 && (
          <p className="hint compact" style={{ marginTop: "0.5rem" }}>{readyAccounts.length} of {smtpAccounts.length} ready to send.</p>
        )}
      </Card>

      <Card
        title="LinkedIn"
        action={
          <button type="button" className="btn primary small" onClick={onOpenAutoFetch}>
            {linkedInConnected ? "Manage" : "Connect LinkedIn"}
          </button>
        }
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span className={linkedInConnected ? "badge ok" : "badge warn"}>{linkedInConnected ? "Connected" : "Not connected"}</span>
          <span className="hint compact">{linkedInConnected ? "Auto-fetching new posts on your schedule." : "Install the extension and connect to start scraping."}</span>
        </div>
      </Card>

      <div>
        <h3 style={{ margin: "0 0 0.5rem", fontSize: "1rem" }}>Email</h3>
        <p className="hint compact" style={{ margin: "0 0 0.6rem" }}>Who writes each role&apos;s email — pick per role below. Template content itself stays on the Email Templates tab.</p>
        <EmailConfigTab
          recipients={recipients}
          templates={templates}
          roleDefs={roleDefs}
          activeRole={activeRole}
          onActiveRoleChange={onActiveRoleChange}
          onUpdateRoleRules={onUpdateRoleRules}
        />
      </div>

      <Card title="Resume" action={<button type="button" className="btn ghost small" onClick={onGoToResumes}>Manage in Resumes →</button>}>
        {defaultResume ? (
          <p className="hint compact" style={{ margin: 0 }}>Default resume: <strong>{defaultResume.name}</strong></p>
        ) : (
          <p className="hint compact" style={{ margin: 0 }}>No default resume set yet — build or upload one on the Resumes tab.</p>
        )}
      </Card>

      <Card title="Account">
        <p className="hint compact" style={{ marginBottom: "0.75rem" }}>Update the password you use to log into Cuneihire.</p>
        <form onSubmit={onPasswordChangeSubmit} className="grid-2" style={{ alignItems: "flex-end" }}>
          <label className="field">
            <span>New Password</span>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => onNewPasswordChange(e.target.value)}
              placeholder="Min 6 characters"
              disabled={passwordLoading}
            />
          </label>
          <button type="submit" className="btn primary" disabled={passwordLoading || !newPassword}>
            {passwordLoading ? "Updating..." : "Update Password"}
          </button>
        </form>
      </Card>
    </div>
  );
}
