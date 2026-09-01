"use client";

import { useState } from "react";
import { JamsOverviewTab } from "./JamsOverviewTab";
import { JamsTab } from "./JamsTab";
import { ResponsesTab } from "./ResponsesTab";
import type {
  AutomailConfig,
  CandidateProfile,
  Recipient,
  ReplyRecord,
  Role,
  RoleDef,
  RoleTemplate,
  SentRecord,
  SmtpAccount,
  SmtpConfig,
} from "@/lib/types";

type JamsSubTab = "overview" | "emails" | "responses";

type Props = {
  userId: string | null;
  profile: CandidateProfile;
  automail: AutomailConfig;
  smtpAccounts: SmtpAccount[];
  sentTodayCount: number;
  globalMaxDailyLimit: number;
  aiCredits: number;
  appCredits: number;
  sentLog: SentRecord[];
  onOpenQuickSend: () => void;
  // JamsTab's own props, passed straight through to the "Emails" sub-tab.
  recipients: Recipient[];
  roleDefs: RoleDef[];
  templates: Record<Role, RoleTemplate[]>;
  config: SmtpConfig;
  onSentLogChange: (sentLog: SentRecord[]) => void;
  replies: ReplyRecord[];
  sending: boolean;
  onSendingChange: (sending: boolean) => void;
  delaySec: number;
  onDelayChange: (delaySec: number) => void;
  onUpdateStatus?: (id: string, field: "status" | "phone_status", newStatus: string) => Promise<void>;
};

// JAMS as the app's main landing page (2026-08-25, operator ask — "just keep like jams as our main
// dashboard... in jams we can have like tabs of like overall... one for the mails that have been went out,
// like the CRM structure that we have right now, one for the monitoring"). Replaces the old standalone
// Dashboard tab — this owns the page-level "JAMS" header + tab strip; Overview/Emails/Monitoring are just
// what they render into.
export function JamsHub({
  userId,
  profile,
  automail,
  smtpAccounts,
  sentTodayCount,
  globalMaxDailyLimit,
  aiCredits,
  appCredits,
  sentLog,
  onOpenQuickSend,
  recipients,
  roleDefs,
  templates,
  config,
  onSentLogChange,
  replies,
  sending,
  onSendingChange,
  delaySec,
  onDelayChange,
  onUpdateStatus,
}: Props) {
  const [subTab, setSubTab] = useState<JamsSubTab>("overview");

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2>JAMS</h2>
          <span className="hint compact">Your automation&apos;s home — overview, contacts, and activity in one place</span>
        </div>
      </div>
      <div className="panel-body">
        <div style={{ display: "flex", gap: "0.4rem", margin: "0 0 1rem" }}>
          <button type="button" className={`btn ${subTab === "overview" ? "primary" : "ghost"}`} onClick={() => setSubTab("overview")}>
            Overview
          </button>
          <button type="button" className={`btn ${subTab === "emails" ? "primary" : "ghost"}`} onClick={() => setSubTab("emails")}>
            Emails
          </button>
          <button type="button" className={`btn ${subTab === "responses" ? "primary" : "ghost"}`} onClick={() => setSubTab("responses")}>
            Responses
          </button>
        </div>

        {subTab === "overview" && (
          <JamsOverviewTab
            profile={profile}
            automail={automail}
            smtpAccounts={smtpAccounts}
            sentTodayCount={sentTodayCount}
            globalMaxDailyLimit={globalMaxDailyLimit}
            aiCredits={aiCredits}
            appCredits={appCredits}
            recipients={recipients}
            sentLog={sentLog}
            roleDefs={roleDefs}
            onOpenQuickSend={onOpenQuickSend}
          />
        )}

        {subTab === "emails" && (
          <JamsTab
            userId={userId}
            recipients={recipients}
            roleDefs={roleDefs}
            templates={templates}
            config={config}
            automail={automail}
            smtpAccounts={smtpAccounts}
            sentLog={sentLog}
            onSentLogChange={onSentLogChange}
            replies={replies}
            sentTodayCount={sentTodayCount}
            sending={sending}
            onSendingChange={onSendingChange}
            delaySec={delaySec}
            onDelayChange={onDelayChange}
            onUpdateStatus={onUpdateStatus}
          />
        )}

        {subTab === "responses" && (
          userId ? (
            <ResponsesTab
              replies={replies}
              recipients={recipients}
              roleDefs={roleDefs}
              sentLog={sentLog}
              smtpAccounts={smtpAccounts}
              userId={userId}
            />
          ) : (
            <p className="hint">Sign in to see your responses.</p>
          )
        )}
      </div>
    </section>
  );
}
