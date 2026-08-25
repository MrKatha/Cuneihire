"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";

// Localhost-only dev convenience: auto sign in with a dedicated dev account instead of showing the
// login form, so local development doesn't require re-entering credentials every time. Gated on BOTH
// NODE_ENV and the actual hostname so this can never fire against a real deployment even if env vars
// are misconfigured. See docs/role.md's "demo/no-auth mode" note — this is that pattern, scoped to
// this app's need for a real Supabase session (RLS requires one; there's no way to skip auth entirely).
function isLocalDevHost() {
  return (
    process.env.NODE_ENV !== "production" &&
    typeof window !== "undefined" &&
    window.location.hostname === "localhost"
  );
}

import { RoleTemplates } from "@/components/RoleTemplates";
import { EmailConfigTab } from "@/components/EmailConfigTab";
import { ResumeBuilder } from "@/components/ResumeBuilder";
import { SmtpConfigPanel } from "@/components/SmtpConfigPanel";
import { JamsTab } from "@/components/JamsTab";
import { ProfileTab } from "@/components/ProfileTab";
import { JobsRolesTab } from "@/components/JobsRolesTab";
import { AutoFetchModal } from "@/components/AutoFetchModal";
import { AITab } from "@/components/AITab";
import { JobBoardTab } from "@/components/JobBoardTab";
import { RecruiterTab } from "@/components/RecruiterTab";
import { LandingPage } from "@/components/LandingPage";
import { AdminPortal } from "@/components/AdminPortal";
import HexMark, { Wordmark } from "@/components/ui/HexMark";
import { supabase } from "@/lib/supabase";
import {
  defaultState,
  loadState,
  saveAppState,
  saveTemplate,
  deleteTemplate,
  setDefaultTemplate,
  saveResume,
  deleteResume,
  setDefaultResume,
  saveResumeProfile,
  deleteResumeProfile,
  syncRecipients,
  deleteAttachment,
  saveRoleDef,
  deleteRoleDef,
  slugifyRoleKey,
  saveSmtpAccount,
  deleteSmtpAccount,
  loadRecruiterProfile,
  becomeRecruiter,
  saveRecruiterProfile,
  loadCandidateProfile,
  saveCandidateProfile,
} from "@/lib/storage";
import { composeResumeData, matchRoleToPosting } from "@/lib/resumeCompose";
import {
  type Recipient,
  type ResumeEntry,
  type ResumeProfile,
  type Role,
  type RoleDef,
  type RoleTemplate,
  type SentRecord,
  type ReplyRecord,
  type SmtpConfig,
  type SmtpAccount,
  type AutoFetchConfig,
  type AiConfig,
  type CandidateProfile,
  type RecruiterProfile,
} from "@/lib/types";

// Scraper & Contacts, Sending & Automail, Quick Send, and Logs were folded into JAMS ("emails") on
// 2026-08-18 — see docs/architecture.md's "JAMS consolidation" section. JAMS is now the landing tab.
// 'board'/'recruiter' (2026-08-19, recruiter portal) — see docs/architecture.md.
// 'profile' (My Profile — the permanent knowledge base) and 'roles' (per-target search criteria + module
// selection) are two separate tabs again (2026-08-19, operator follow-up) — briefly merged into one
// section with an internal sub-tab toggle, reverted for easier navigation: real sidebar entries beat a
// toggle buried inside one page. See docs/architecture.md.
const TAB_NAMES = ["emails", "profile", "roles", "board", "templates", "resumes", "ai", "settings", "recruiter", "admin"] as const;
type TabName = typeof TAB_NAMES[number];

export default function Home() {
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<TabName>("emails");
  // Resumes tab's own Builder/Library sub-tab now lives inside ResumeBuilder itself, alongside the
  // From-your-profile/Start-from-scratch mode (2026-08-24, UI pass) — see that component's resumeSubTab
  // state comment.
  // Email Templates tab's own sub-tabs (2026-08-20, same pattern) — Templates for the wording itself,
  // Configuration for each role's send mode (manual / let AI choose / let AI write it). Not persisted —
  // always opens on Templates.
  const [templatesSubTab, setTemplatesSubTab] = useState<"templates" | "configuration">("templates");
  // Sidebar collapse (2026-08-20, operator ask) — a pure display preference, not app data, so it's kept
  // in localStorage rather than Supabase (same "default on server, correct client-side in an effect"
  // pattern as activeTab above, since localStorage isn't available during SSR).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      setSidebarCollapsed(window.localStorage.getItem("sidebarCollapsed") === "true");
    }
  }, []);

  function toggleSidebarCollapsed() {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") window.localStorage.setItem("sidebarCollapsed", String(next));
      return next;
    });
  }

  useEffect(() => {
    if (typeof window !== "undefined") {
      const currentTab = window.location.pathname.replace('/', '') || 'emails';
      if (TAB_NAMES.includes(currentTab as TabName)) {
        setActiveTab(currentTab as TabName);
      }

      const handlePopState = () => {
        const popTab = window.location.pathname.replace('/', '') || 'emails';
        if (TAB_NAMES.includes(popTab as TabName)) {
          setActiveTab(popTab as TabName);
        }
      };

      window.addEventListener('popstate', handlePopState);
      return () => window.removeEventListener('popstate', handlePopState);
    }
  }, []);

  const handleTabChange = (tab: TabName) => {
    setActiveTab(tab);
    if (typeof window !== "undefined") {
      window.history.pushState(null, '', `/${tab}`);
    }
  };
  
  const [userId, setUserId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showLanding, setShowLanding] = useState(false);
  const devLoginAttempted = useRef(false);
  
  const [hydrated, setHydrated] = useState(false);
  const [config, setConfig] = useState<SmtpConfig>(defaultState().config);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [templates, setTemplates] = useState<Record<Role, RoleTemplate[]>>(
    defaultState().templates
  );
  const [resumes, setResumes] = useState<Record<Role, ResumeEntry[]>>(
    defaultState().resumes
  );
  const [resumeProfiles, setResumeProfiles] = useState<ResumeProfile[]>([]);
  const [delaySec, setDelaySec] = useState(3);
  const [sending, setSending] = useState(false);
  const [activeTemplateRole, setActiveTemplateRole] =
    useState<Role>("fullstack");
  const [defaultTitle, setDefaultTitle] = useState("");
  const [sentLog, setSentLog] = useState<SentRecord[]>([]);
  // Reply monitoring (2026-08-19) — read-only, populated by loadState() and kept live via the realtime
  // subscription below. Only replyPoll.worker.js ever writes automailsend_replies.
  const [replies, setReplies] = useState<ReplyRecord[]>([]);
  const [autoFetch, setAutoFetch] = useState<AutoFetchConfig>(defaultState().autoFetch);
  const [automail, setAutomail] = useState(defaultState().automail);
  const [ai, setAi] = useState<AiConfig>(defaultState().ai);
  const [aiCredits, setAiCredits] = useState(defaultState().aiCredits);
  const [profile, setProfile] = useState<CandidateProfile>(defaultState().profile);
  const [roleDefs, setRoleDefs] = useState<RoleDef[]>([]);
  const [smtpAccounts, setSmtpAccounts] = useState<SmtpAccount[]>([]);
  // Recruiter portal (2026-08-19) — null means the user hasn't activated recruiter mode yet. Loaded
  // alongside the rest of hydrate; see docs/architecture.md's "Recruiter portal" section.
  const [recruiterProfile, setRecruiterProfile] = useState<RecruiterProfile | null>(null);

  const [showAutoFetch, setShowAutoFetch] = useState(false);
  const [showSmtpModal, setShowSmtpModal] = useState(false);

  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);
  
  // Track previous state for targeted saving
  const lastState = useRef({
    config: defaultState().config,
    delaySec: 3,
    activeTemplateRole: "fullstack" as Role,
    defaultTitle: "",
    autoFetch: defaultState().autoFetch,
    automail: defaultState().automail,
  });
  
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Candidate profile's own debounced save (2026-08-19) — separate table/timer from the app_state one
  // above; see the dedicated effect further down.
  const profileSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedProfile = useRef<CandidateProfile | null>(null);

  const sentTodayCount = sentLog.filter(s => s.status === 'sent' && new Date(s.sentAt).toDateString() === new Date().toDateString()).length;

  useEffect(() => {
    // `devLoginAttempted` only guards against firing a second signInWithPassword call while one is
    // already in flight (getSession() and the initial onAuthStateChange event can both land at
    // ~the same time on mount) — it resets after every attempt, so an actual logout later still
    // triggers a fresh auto-login rather than getting permanently skipped.
    const handleNoSession = () => {
      if (isLocalDevHost() && !devLoginAttempted.current) {
        const devEmail = process.env.NEXT_PUBLIC_DEV_AUTO_LOGIN_EMAIL;
        const devPassword = process.env.NEXT_PUBLIC_DEV_AUTO_LOGIN_PASSWORD;
        if (devEmail && devPassword) {
          devLoginAttempted.current = true;
          supabase.auth.signInWithPassword({ email: devEmail, password: devPassword }).then(({ error }) => {
            devLoginAttempted.current = false;
            if (error) {
              console.warn("[dev auto-login] failed, falling back to normal login:", error.message);
              if (typeof window !== 'undefined' && window.location.pathname === '/') {
                setShowLanding(true);
                setHydrated(true);
              } else {
                router.push("/login");
              }
            }
            // on success, onAuthStateChange fires again with a real session — handled below
          });
          return;
        }
      }
      if (typeof window !== 'undefined' && window.location.pathname === '/') {
        setShowLanding(true);
        setHydrated(true);
      } else {
        router.push("/login");
      }
    };

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        handleNoSession();
      } else {
        setUserId(session.user.id);
        const adminEmails = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "").split(",");
        setIsAdmin(adminEmails.includes(session.user.email || ""));
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!session) {
        setUserId(null);
        handleNoSession();
      } else {
        setShowLanding(false);
        setUserId(session.user.id);
        const adminEmails = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "").split(",");
        setIsAdmin(adminEmails.includes(session.user.email || ""));
      }
    });

    return () => subscription.unsubscribe();
  }, [router]);

  useEffect(() => {
    if (!userId) return;

    loadState(userId).then((saved) => {
      setConfig(saved.config);
      setRecipients(saved.recipients);
      setTemplates(saved.templates);
      setResumes(saved.resumes);
      setResumeProfiles(saved.resumeProfiles);
      setDelaySec(saved.delaySec);
      setActiveTemplateRole(saved.activeTemplateRole);
      setDefaultTitle(saved.defaultTitle);
      setSentLog(saved.sentLog);
      setReplies(saved.replies);
      setAutoFetch(saved.autoFetch);
      setAutomail(saved.automail);
      setAi(saved.ai);
      setAiCredits(saved.aiCredits);
      setRoleDefs(saved.roleDefs);
      setSmtpAccounts(saved.smtpAccounts);
      setSending(saved.batchSendPending);

      lastState.current = {
        config: saved.config,
        delaySec: saved.delaySec,
        activeTemplateRole: saved.activeTemplateRole,
        defaultTitle: saved.defaultTitle,
        autoFetch: saved.autoFetch,
        automail: saved.automail,
      };

      setHydrated(true);
    });

    // Own table, own load (2026-08-19) — no longer part of loadState()/PersistedState's app_state round
    // trip. Track what was actually loaded so the debounced save effect above doesn't immediately fire an
    // identical upsert right after hydrate.
    loadCandidateProfile(userId).then((loaded) => {
      setProfile(loaded);
      lastSavedProfile.current = loaded;
    });

    // Separate table, separate concern (see RecruiterProfile's comment in types.ts) — not part of
    // PersistedState/loadState above.
    //
    // Account type is chosen once at signup (candidate vs. recruiter — see signup/page.tsx) and stored in
    // the session's own user_metadata, not created via an in-app "Become a Recruiter" button any more —
    // one email is one account type for good. The actual automailsend_recruiter_profiles row is created
    // here, on first login after signup, rather than immediately after signUp() — a project with email
    // confirmation enabled has no authenticated session yet at that moment, so an insert gated by
    // `auth.uid() = user_id` RLS would fail; first login is the first point a real session is guaranteed.
    // becomeRecruiter() only ever runs once per account (guarded by the `!profile` check), so a repeat
    // login is a no-op.
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      const accountType = session?.user?.user_metadata?.account_type;
      const profile = await loadRecruiterProfile(userId);
      if (!profile && accountType === "recruiter") {
        setRecruiterProfile(await becomeRecruiter(userId));
      } else {
        setRecruiterProfile(profile);
      }
    });
  }, [userId]);

  // A recruiter landing on the bare root should see their own portal, not the candidate JAMS view — only
  // fires on the true first load (pathname still "/"), so it never fights normal tab navigation.
  useEffect(() => {
    if (recruiterProfile && typeof window !== "undefined" && window.location.pathname === "/") {
      handleTabChange("recruiter");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recruiterProfile]);

  // A brand-new candidate starts with zero roles (2026-08-18: no preloaded DevOps/Fullstack/AI Automation
  // defaults — the candidate adds their own on Jobs & Roles' "+ Add title"). defaultState() still has to
  // give activeTemplateRole *some* initial value ("fullstack"), but Templates/Resumes don't have Jobs &
  // Roles' own `|| roleDefs[0]` fallback — left alone, that unmatched placeholder would let a template or
  // resume get saved under a role key that was never actually added. Once real roles load, repoint
  // activeTemplateRole at one that exists.
  useEffect(() => {
    if (roleDefs.length === 0) return;
    if (!roleDefs.some((d) => d.key === activeTemplateRole)) {
      setActiveTemplateRole(roleDefs[0].key);
    }
  }, [roleDefs, activeTemplateRole]);

  // Realtime updates from background worker
  useEffect(() => {
    if (!userId || !hydrated) return;

    const channel = supabase.channel('table-db-changes')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'automailsend_recipients',
          filter: `user_id=eq.${userId}`
        },
        (payload) => {
          if (payload.eventType === 'DELETE') {
             setRecipients(prev => prev.filter(r => r.id !== payload.old.id));
             return;
          }
          const newRow = payload.new;
          setRecipients((prev) => {
            const exists = prev.some(r => r.id === newRow.id);
            // Full field set (mirrors storage.ts's loadState() mapping) — a narrower shape here used to
            // silently drop match_score/context_text/reply fields etc. on every realtime UPDATE, not just
            // fail to add new ones (found while wiring in reply monitoring, 2026-08-19).
            const rowData: Recipient = {
              id: newRow.id,
              email: newRow.email,
              role: newRow.role as Role,
              title: newRow.title,
              phone: newRow.phone,
              status: newRow.status || 'pending',
              phone_status: newRow.phone_status || 'pending',
              source: newRow.source || 'auto_fetch',
              source_url: newRow.source_url,
              job_post_id: newRow.job_post_id,
              author_name: newRow.author_name || undefined,
              context_text: newRow.context_text || undefined,
              match_score: newRow.match_score ?? null,
              match_reasoning: newRow.match_reasoning || null,
              match_analyzed_at: newRow.match_analyzed_at || null,
              scraped_at: newRow.scraped_at,
              hasReplied: !!newRow.has_replied,
              repliedAt: newRow.replied_at || undefined,
              replyCount: newRow.reply_count || 0,
            };
            if (exists) {
              return prev.map(r => r.id === newRow.id ? rowData : r);
            }
            return [rowData, ...prev];
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'automailsend_execution_logs',
          filter: `user_id=eq.${userId}`
        },
        (payload) => {
          const log = payload.new;
          if (log.details && (log.details.new_emails?.length > 0 || log.details.new_phones?.length > 0)) {
            const eCount = log.details.new_emails?.length || 0;
            const pCount = log.details.new_phones?.length || 0;
            toast.success(`Auto-Fetch found ${eCount} emails & ${pCount} phones!`);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'automailsend_sent_log',
          filter: `user_id=eq.${userId}`
        },
        (payload) => {
          const newLog = payload.new;
          setSentLog((prev) => {
            // Avoid duplicates
            if (prev.some(s => s.email === newLog.email && s.role === newLog.role && s.sentAt === newLog.sent_at)) {
              return prev;
            }
            return [{
              email: newLog.email,
              role: newLog.role as Role,
              title: newLog.title || "",
              subject: newLog.subject || undefined,
              body: newLog.body || undefined,
              status: newLog.status || "sent",
              error: newLog.error_message || undefined,
              sentAt: newLog.sent_at,
              templateLabel: newLog.template_label || undefined,
              resumeLabel: newLog.resume_label || undefined,
            }, ...prev];
          });
          // Also toast success/fail if it was from background job
          if (newLog.status === 'sent') {
            toast.success(`Sent email to ${newLog.email}`);
          } else if (newLog.status === 'failed') {
            toast.error(`Failed sending to ${newLog.email}`);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'automailsend_replies',
          filter: `user_id=eq.${userId}`
        },
        (payload) => {
          const newReply = payload.new;
          setReplies((prev) => {
            if (prev.some(r => r.id === newReply.id)) return prev;
            return [{
              id: newReply.id,
              recipientId: newReply.recipient_id || undefined,
              fromEmail: newReply.from_email,
              subject: newReply.subject || undefined,
              bodySnippet: newReply.body_snippet || undefined,
              receivedAt: newReply.received_at || newReply.created_at,
              matchMethod: newReply.match_method || undefined,
            }, ...prev];
          });
          if (newReply.recipient_id) {
            setRecipients((prev) => prev.map(r => r.id === newReply.recipient_id
              ? { ...r, hasReplied: true, repliedAt: new Date().toISOString(), replyCount: (r.replyCount || 0) + 1 }
              : r
            ));
          }
          toast.success(`New reply from ${newReply.from_email}!`);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, hydrated]);

  // Debounced auto-save for app_state
  useEffect(() => {
    if (!hydrated || !userId) return;
    
    // Only save if app_state parts changed. `profile` isn't part of this any more — it has its own
    // debounced save against automailsend_candidate_profiles below (its own table since 2026-08-19).
    const currState = { config, delaySec, activeTemplateRole, defaultTitle, autoFetch, automail, ai, batchSendPending: sending };
    if (JSON.stringify(currState) === JSON.stringify(lastState.current)) {
      return;
    }

    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveAppState(userId, {
        config,
        recipients, // not saved in app_state
        templates, // not saved in app_state (own table)
        resumes, // not saved in app_state (own table)
        resumeProfiles, // not saved in app_state (own table)
        roleDefs, // not saved in app_state (own table)
        smtpAccounts, // not saved in app_state (own table)
        delaySec,
        activeTemplateRole,
        defaultTitle,
        sentLog, // not saved in app_state
        replies, // not saved in app_state — read-only, written only by replyPoll.worker.js
        autoFetch,
        automail,
        ai,
        aiCredits, // not saved in app_state — admin-granted, read-only from here
        profile,
        batchSendPending: sending,
      }).then(() => {
         lastState.current = currState;
      }).catch(console.error);
    }, 1000);

    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [hydrated, userId, config, delaySec, activeTemplateRole, defaultTitle, autoFetch, automail, ai, recipients, sentLog]);

  // Debounced auto-save for the candidate profile (2026-08-19) — its own table/save path now, separate
  // from the app_state round trip above (see storage.ts's saveCandidateProfile).
  useEffect(() => {
    if (!hydrated || !userId) return;
    if (lastSavedProfile.current && JSON.stringify(profile) === JSON.stringify(lastSavedProfile.current)) return;

    if (profileSaveTimer.current) clearTimeout(profileSaveTimer.current);
    profileSaveTimer.current = setTimeout(() => {
      saveCandidateProfile(userId, profile).then(() => {
        lastSavedProfile.current = profile;
      }).catch(console.error);
    }, 800);

    return () => {
      if (profileSaveTimer.current) clearTimeout(profileSaveTimer.current);
    };
  }, [hydrated, userId, profile]);

  // Email template library (2026-08-18) — real per-row CRUD now that a role can have many templates,
  // mirrors handleSaveSmtpAccount/handleDeleteSmtpAccount above rather than the old debounced-blob save.
  async function handleSaveTemplate(role: Role, template: Partial<RoleTemplate> & { id?: string }) {
    if (!userId) return null;
    const saved = await saveTemplate(userId, role, template);
    if (!saved) {
      toast.error("Failed to save template.");
      return null;
    }
    setTemplates((prev) => ({
      ...prev,
      [role]: template.id
        ? (prev[role] || []).map((t) => (t.id === saved.id ? saved : t))
        : [...(prev[role] || []), saved],
    }));
    return saved;
  }

  async function handleDeleteTemplate(role: Role, id: string) {
    await deleteTemplate(id).catch(console.error);
    setTemplates((prev) => ({ ...prev, [role]: (prev[role] || []).filter((t) => t.id !== id) }));
  }

  async function handleSetDefaultTemplate(role: Role, id: string) {
    if (!userId) return;
    await setDefaultTemplate(userId, role, id).catch(console.error);
    setTemplates((prev) => ({
      ...prev,
      [role]: (prev[role] || []).map((t) => ({ ...t, isDefault: t.id === id })),
    }));
  }

  // Resume library (2026-08-18) — same pattern, deliberately separate from templates.
  async function handleSaveResume(role: Role, resume: Partial<ResumeEntry> & { id?: string }) {
    if (!userId) return null;
    const saved = await saveResume(userId, role, resume);
    if (!saved) {
      toast.error("Failed to save resume.");
      return null;
    }
    setResumes((prev) => ({
      ...prev,
      [role]: resume.id
        ? (prev[role] || []).map((r) => (r.id === saved.id ? saved : r))
        : [...(prev[role] || []), saved],
    }));
    return saved;
  }

  async function handleDeleteResume(role: Role, id: string) {
    await deleteResume(id).catch(console.error);
    setResumes((prev) => ({ ...prev, [role]: (prev[role] || []).filter((r) => r.id !== id) }));
  }

  async function handleSetDefaultResume(role: Role, id: string) {
    if (!userId) return;
    await setDefaultResume(userId, role, id).catch(console.error);
    setResumes((prev) => ({
      ...prev,
      [role]: (prev[role] || []).map((r) => ({ ...r, isDefault: r.id === id })),
    }));
  }

  // Resume Builder profiles (2026-08-18) — structured resumes, distinct from the file library above.
  async function handleSaveResumeProfile(profile: Partial<ResumeProfile> & { id?: string }) {
    if (!userId) return null;
    const saved = await saveResumeProfile(userId, profile);
    if (!saved) {
      toast.error("Failed to save resume.");
      return null;
    }
    setResumeProfiles((prev) => (profile.id ? prev.map((p) => (p.id === saved.id ? saved : p)) : [...prev, saved]));
    return saved;
  }

  async function handleDeleteResumeProfile(id: string) {
    await deleteResumeProfile(id).catch(console.error);
    setResumeProfiles((prev) => prev.filter((p) => p.id !== id));
  }

  async function handleAddRole(label: string) {
    if (!userId || !label.trim()) return;
    const key = slugifyRoleKey(label.trim());
    if (roleDefs.some((r) => r.key === key)) {
      toast.error("A role with a similar name already exists.");
      return;
    }
    // New roles default to "everything selected" from the current profile — the forgiving default (see
    // RoleDef's comment in types.ts): a candidate trims a role down rather than starting from a resume
    // missing something they forgot to add.
    const saved = await saveRoleDef(userId, {
      key,
      label: label.trim(),
      selectedExperienceIds: profile.experience.map((e) => e.id),
      selectedEducationIds: profile.education.map((e) => e.id),
      selectedProjectIds: profile.projects.map((p) => p.id),
      selectedCertificationIds: profile.certifications.map((c) => c.id),
      selectedSkillIds: profile.skills.map((s) => s.id),
      selectedFileIds: profile.files.map((f) => f.id),
    });
    if (!saved) {
      toast.error("Failed to add role.");
      return;
    }
    setRoleDefs((prev) => [...prev, saved]);
    toast.success("Role added!");
  }

  async function handleRenameRole(id: string, newLabel: string) {
    if (!userId || !newLabel.trim()) return;
    const existing = roleDefs.find((r) => r.id === id);
    if (!existing) return;
    // Key stays fixed once created — renaming only changes the display label, so existing
    // recipients/templates/sent_log rows (which store the key, not the label) stay linked.
    const saved = await saveRoleDef(userId, { id, key: existing.key, label: newLabel.trim() });
    if (!saved) {
      toast.error("Failed to rename role.");
      return;
    }
    setRoleDefs((prev) => prev.map((r) => (r.id === id ? saved : r)));
  }

  async function handleDeleteRole(id: string) {
    if (roleDefs.length <= 1) {
      toast.error("You need at least one role.");
      return;
    }
    await deleteRoleDef(id).catch(console.error);
    setRoleDefs((prev) => prev.filter((r) => r.id !== id));
  }

  // Keywords + job-search "rules" (work mode, salary, location, notes) — set on the Jobs & Roles page.
  async function handleUpdateRoleRules(id: string, patch: Partial<RoleDef>) {
    if (!userId) return;
    const existing = roleDefs.find((r) => r.id === id);
    if (!existing) return;
    const saved = await saveRoleDef(userId, { ...existing, ...patch });
    if (!saved) {
      toast.error("Failed to update role.");
      return;
    }
    setRoleDefs((prev) => prev.map((r) => (r.id === id ? saved : r)));
  }

  // Shared by JobsRolesTab (per-role matched-job-post cards) and JamsTab (contact tracking) — both let the
  // user update a contact's email/phone status inline, so this lives once here rather than twice.
  async function handleUpdateRecipientStatus(id: string, field: 'status' | 'phone_status', newStatus: string) {
    const updated = recipients.map(r => r.id === id ? { ...r, [field]: newStatus } : r);
    setRecipients(updated);
    await supabase.from("automailsend_recipients").update({ [field]: newStatus }).eq("id", id);
  }

  async function handleSaveSmtpAccount(
    account: Partial<SmtpAccount> & { id?: string; email: string; appPassword: string }
  ): Promise<SmtpAccount | null> {
    if (!userId) return null;
    const saved = await saveSmtpAccount(userId, account);
    if (!saved) {
      toast.error("Failed to save SMTP account.");
      return null;
    }
    setSmtpAccounts((prev) =>
      account.id ? prev.map((a) => (a.id === saved.id ? saved : a)) : [...prev, saved]
    );
    return saved;
  }

  async function handleDeleteSmtpAccount(id: string) {
    await deleteSmtpAccount(id).catch(console.error);
    setSmtpAccounts((prev) => prev.filter((a) => a.id !== id));
  }

  async function handleSaveRecruiterProfile(updates: Partial<Pick<RecruiterProfile, "companyName" | "atsAiEnabled">>) {
    if (!userId) return;
    const updated = await saveRecruiterProfile(userId, updates);
    if (updated) setRecruiterProfile(updated);
  }

  function resetAll() {
    // Delete all attachments from buckets before resetting (both libraries hold files)
    Object.values(templates).flat().forEach(tpl => {
      tpl.files.forEach(f => deleteAttachment(f.storagePath).catch(console.error));
    });
    Object.values(resumes).flat().forEach(r => {
      r.files.forEach(f => deleteAttachment(f.storagePath).catch(console.error));
    });

    // Only resetting local state for demo purposes, you might want a DB wipe
    const fresh = defaultState();
    setConfig(fresh.config);
    setRecipients([]);
    setTemplates(fresh.templates);
    setResumes(fresh.resumes);
    setDelaySec(fresh.delaySec);
    setActiveTemplateRole(fresh.activeTemplateRole);
    setDefaultTitle(fresh.defaultTitle);
    setSentLog(fresh.sentLog);
    setAutoFetch(fresh.autoFetch);

    if (userId) {
      saveAppState(userId, fresh).catch(console.error);
      // Real per-row entities now — delete each directly rather than one bulk upsert-by-role call.
      Object.values(templates).flat().forEach(t => deleteTemplate(t.id).catch(console.error));
      Object.values(resumes).flat().forEach(r => deleteResume(r.id).catch(console.error));
      syncRecipients(userId, []).catch(console.error);
    }
  }

  async function handleLogout() {
    await supabase.auth.signOut();
  }

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    if (!newPassword || newPassword.length < 6) {
      toast.error("Password must be at least 6 characters");
      return;
    }
    setPasswordLoading(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setPasswordLoading(false);
    if (error) {
      toast.error(error.message || "Failed to update password");
    } else {
      toast.success("Login password updated successfully!");
      setNewPassword("");
    }
  }

  if (showLanding) {
    return <LandingPage />;
  }

  if (!hydrated || !userId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', width: '100vw', background: 'var(--bg)', position: 'fixed', top: 0, left: 0, zIndex: 9999 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5rem', opacity: 0, animation: 'fadeIn 0.5s ease-out forwards' }}>
          <HexMark variant="outline" size={56} />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem' }}>
            <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 650, color: 'var(--ink)', letterSpacing: '-0.02em', fontFamily: 'var(--font-display), Georgia, serif' }}>Cuneihire</h2>
            <p className="label-eyebrow" style={{ margin: 0 }}>Preparing your workspace...</p>
          </div>
          <div style={{ width: '12rem', height: '3px', background: 'var(--line)', overflow: 'hidden', marginTop: '0.5rem' }}>
            <div style={{ height: '100%', background: 'var(--accent)', animation: 'indeterminate-progress 1.5s ease-in-out infinite' }} />
          </div>
        </div>
        <style>{`
          @keyframes indeterminate-progress {
            0% { transform: translateX(-100%); width: 40%; }
            50% { transform: translateX(30%); width: 80%; }
            100% { transform: translateX(250%); width: 40%; }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="app-container">
      <aside className={`sidebar${sidebarCollapsed ? ' collapsed' : ''}`}>
        <div className="sidebar-title">
          <Wordmark />
        </div>
        <nav className="sidebar-nav">
          <button
            className={`sidebar-tab ${activeTab === 'emails' ? 'active' : ''}`}
            onClick={() => handleTabChange('emails')}
          >
            JAMS
          </button>
          <button
            className={`sidebar-tab ${activeTab === 'board' ? 'active' : ''}`}
            onClick={() => handleTabChange('board')}
          >
            Job Board
          </button>
          <button
            className={`sidebar-tab ${activeTab === 'profile' ? 'active' : ''}`}
            onClick={() => handleTabChange('profile')}
          >
            My Profile
          </button>
          <button
            className={`sidebar-tab ${activeTab === 'roles' ? 'active' : ''}`}
            onClick={() => handleTabChange('roles')}
          >
            Roles
          </button>
          <button
            className={`sidebar-tab ${activeTab === 'templates' ? 'active' : ''}`}
            onClick={() => handleTabChange('templates')}
          >
            Email Templates
          </button>
          <button
            className={`sidebar-tab ${activeTab === 'resumes' ? 'active' : ''}`}
            onClick={() => handleTabChange('resumes')}
          >
            Resumes
          </button>
          <button
            className={`sidebar-tab ${activeTab === 'ai' ? 'active' : ''}`}
            onClick={() => handleTabChange('ai')}
          >
            AI
          </button>
          <button
            className={`sidebar-tab ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => handleTabChange('settings')}
          >
            Settings
          </button>
          {/* Recruiter sidebar entry hidden for now (2026-08-25, operator ask) — recruiter is its own
              phase with its own profile/portal not built yet; candidates shouldn't see it as an option
              right now. Signup's account-type toggle is disabled the same way (see signup/page.tsx), so
              no new recruiter accounts can be created either. The tab/route/RecruiterTab.tsx are all left
              intact for when that phase starts — this is a one-button revert. */}
          {isAdmin && (
            <button 
              className={`sidebar-tab ${activeTab === 'admin' ? 'active' : ''}`}
              onClick={() => handleTabChange('admin')}
              style={{
                color: "var(--danger)",
                fontWeight: 650,
                marginTop: '1rem',
                border: "1px solid color-mix(in srgb, var(--danger) 30%, transparent)",
                background: activeTab === 'admin' ? "color-mix(in srgb, var(--danger) 15%, transparent)" : "color-mix(in srgb, var(--danger) 5%, transparent)"
              }}
            >
              Admin Portal 🛡️
            </button>
          )}
        </nav>
        
        <div style={{ marginTop: 'auto' }}>
          <button onClick={handleLogout} className="btn ghost danger" style={{ width: '100%', justifyContent: 'center' }}>
            Log Out
          </button>
        </div>
      </aside>

      <button
        type="button"
        className="sidebar-toggle"
        onClick={toggleSidebarCollapsed}
        title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        {sidebarCollapsed ? '›' : '‹'}
      </button>

      <main className="main-content">
        {/* Resume Builder height chain (2026-08-20) — the fixed, non-scrolling page-viewport layout needs
            a definite height to fill down from .main-content, which is display:block by default (shared
            by every tab, so only conditionally opted into flex-column here, scoped to Resumes, rather than
            changing the CSS class globally). See ResumeBuilder.tsx's root wrapper for the rest of the
            chain and docs/architecture.md's dated follow-up for why every link in it matters. */}
        <div className="board" style={activeTab === 'resumes' ? { height: "100%", display: "flex", flexDirection: "column", minHeight: 0 } : undefined}>
          {activeTab === 'profile' && (
            <ProfileTab
              profile={profile}
              onProfileChange={setProfile}
              automail={automail}
              onAutomailChange={setAutomail}
            />
          )}

          {activeTab === 'roles' && (
            <JobsRolesTab
              roleDefs={roleDefs}
              recipients={recipients}
              profile={profile}
              onProfileChange={setProfile}
              activeRole={activeTemplateRole}
              onActiveRoleChange={setActiveTemplateRole}
              onAddRole={handleAddRole}
              onRenameRole={handleRenameRole}
              onDeleteRole={handleDeleteRole}
              onUpdateRoleRules={handleUpdateRoleRules}
              onUpdateStatus={handleUpdateRecipientStatus}
            />
          )}

          {activeTab === 'board' && userId && (
            <JobBoardTab
              userId={userId}
              resumeProfiles={resumeProfiles}
              resumes={resumes}
              candidateProfile={profile}
              roleDefs={roleDefs}
              onSaveResumeProfile={handleSaveResumeProfile}
            />
          )}

          {activeTab === 'emails' && (
            <JamsTab
              userId={userId}
              recipients={recipients}
              roleDefs={roleDefs}
              templates={templates}
              config={config}
              automail={automail}
              ai={ai}
              smtpAccounts={smtpAccounts}
              profile={profile}
              sentLog={sentLog}
              onSentLogChange={setSentLog}
              replies={replies}
              sentTodayCount={sentTodayCount}
              sending={sending}
              onSendingChange={setSending}
              delaySec={delaySec}
              onDelayChange={setDelaySec}
              onUpdateStatus={handleUpdateRecipientStatus}
            />
          )}

          {activeTab === 'templates' && (
            <section className="panel">
              <div className="panel-head">
                <h2>Email Templates</h2>
                <span className="hint compact">Write templates per role, and choose how each role sends</span>
              </div>
              <div style={{ display: "flex", gap: "0.4rem", margin: "0 0 1rem" }}>
                <button
                  type="button"
                  className={`btn ${templatesSubTab === 'templates' ? 'primary' : 'ghost'}`}
                  onClick={() => setTemplatesSubTab('templates')}
                >
                  Templates
                </button>
                <button
                  type="button"
                  className={`btn ${templatesSubTab === 'configuration' ? 'primary' : 'ghost'}`}
                  onClick={() => setTemplatesSubTab('configuration')}
                >
                  Configuration
                </button>
              </div>

              {templatesSubTab === 'templates' && (
                <RoleTemplates
                  recipients={recipients}
                  templates={templates}
                  activeRole={activeTemplateRole}
                  onActiveRoleChange={setActiveTemplateRole}
                  onSave={handleSaveTemplate}
                  onDelete={handleDeleteTemplate}
                  roleDefs={roleDefs}
                  onUpdateRoleRules={handleUpdateRoleRules}
                />
              )}
              {templatesSubTab === 'configuration' && (
                <EmailConfigTab
                  recipients={recipients}
                  templates={templates}
                  roleDefs={roleDefs}
                  activeRole={activeTemplateRole}
                  onActiveRoleChange={setActiveTemplateRole}
                  onUpdateRoleRules={handleUpdateRoleRules}
                />
              )}
            </section>
          )}

          {activeTab === 'resumes' && (
            <div style={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}>
              <div className="panel-head" style={{ marginBottom: "0.4rem" }}>
                <h2>Resumes</h2>
                <span className="hint compact">Build resumes per role, and pick your default in the Library</span>
              </div>
              {/* Builder/Library toggle (and, inside Builder, the From-your-profile/Start-from-scratch mode
                  and role switcher) all now live inside ResumeBuilder itself as one flat tab row
                  (2026-08-24, UI pass — reclaiming height that two stacked tab rows here used to cost) — see
                  its resumeSubTab state comment. */}
              <ResumeBuilder
                userId={userId}
                candidateProfile={profile}
                onProfileChange={setProfile}
                profiles={resumeProfiles}
                ai={ai}
                roleDefs={roleDefs}
                activeRole={activeTemplateRole}
                onActiveRoleChange={setActiveTemplateRole}
                onUpdateRoleRules={handleUpdateRoleRules}
                onSave={handleSaveResumeProfile}
                onDelete={handleDeleteResumeProfile}
              />
            </div>
          )}

          {activeTab === 'ai' && (
            <AITab ai={ai} aiCredits={aiCredits} onSave={setAi} />
          )}

          {activeTab === 'recruiter' && userId && (
            <RecruiterTab
              userId={userId}
              recruiterProfile={recruiterProfile}
              onSaveProfile={handleSaveRecruiterProfile}
            />
          )}

          {activeTab === 'admin' && isAdmin && (
            <div className="panel flex-col gap-4">
              <AdminPortal />
            </div>
          )}

          {activeTab === 'admin' && !isAdmin && (
            <div className="panel flex-col gap-4" style={{ textAlign: "center", padding: "4rem 2rem" }}>
              <div style={{ fontSize: "3rem", marginBottom: "1rem" }}>🔒</div>
              <h2 className="panel-title" style={{ color: "var(--err)" }}>Access Denied</h2>
              <p className="hint">You do not have administrative privileges to view this portal.</p>
              <button className="btn primary" onClick={() => handleTabChange('emails')} style={{ margin: "1rem auto 0" }}>
                Return to Dashboard
              </button>
            </div>
          )}

          {activeTab === 'settings' && (
            <div className="panel flex-col gap-4">
              <h2 className="panel-title">Application Settings</h2>
              <div className="smtp-bar" style={{ marginTop: '0.5rem' }}>
                <div className="smtp-bar-left">
                  <span className="smtp-bar-title">Account & SMTP Settings</span>
                  <span className={smtpAccounts.some(a => a.isVerified && a.isActive) ? "badge ok" : "badge warn"}>
                    {smtpAccounts.length === 0 ? "Setup needed" : `${smtpAccounts.filter(a => a.isVerified && a.isActive).length} account(s) ready`}
                  </span>
                </div>
                <div className="smtp-bar-actions">
                  <button type="button" className="btn primary" onClick={() => setShowSmtpModal(true)}>
                    Expand
                  </button>
                </div>
              </div>
              <div className="smtp-bar" style={{ marginTop: '0.5rem' }}>
                <div className="smtp-bar-left">
                  <span className="smtp-bar-title">LinkedIn Scraper Settings</span>
                  <span className={autoFetch.enabled ? "badge ok" : "badge warn"}>
                    {autoFetch.enabled ? "Active" : "Disabled"}
                  </span>
                </div>
                <div className="smtp-bar-actions">
                  <button type="button" className="btn primary" onClick={() => setShowAutoFetch(true)}>
                    Expand
                  </button>
                </div>
              </div>

              {/* Activate Automation (2026-08-25, operator ask — this used to be an "Expand" -> full
                  modal, same as the rows above; not any more. This is the whole thing: a toggle, plus
                  the one setting worth keeping, daily limit. No template requirement to turn it on — AI
                  write mode needs no template at all. Changes save immediately via the existing
                  `automail` debounced-autosave effect above, same as every other app_state field — no
                  separate Save button. The actual cap is enforced backend-side in automail.worker.js. */}
              <div className="smtp-bar" style={{ marginTop: '0.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                <div className="smtp-bar-left">
                  <span className="smtp-bar-title">Activate Automation</span>
                  <span className={automail.enabled ? "badge ok" : "badge warn"}>
                    {automail.enabled ? "Active" : "Inactive"}
                  </span>
                </div>
                <div className="smtp-bar-actions" style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
                    Daily limit
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={automail.dailyLimit}
                      onChange={(e) => setAutomail({ ...automail, dailyLimit: Number(e.target.value) || 1 })}
                      style={{ width: '70px' }}
                    />
                    <span>(sent today: {sentTodayCount})</span>
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <input
                      type="checkbox"
                      checked={automail.enabled}
                      disabled={!smtpAccounts.some(a => a.isVerified && a.isActive)}
                      onChange={(e) => setAutomail({ ...automail, enabled: e.target.checked })}
                      style={{ width: '1.2rem', height: '1.2rem' }}
                    />
                    <span style={{ fontSize: '0.85rem', color: automail.enabled ? 'var(--ok)' : 'var(--muted)' }}>
                      {automail.enabled ? 'Active' : 'Inactive'}
                    </span>
                  </label>
                </div>
                {!smtpAccounts.some(a => a.isVerified && a.isActive) && (
                  <p className="hint compact" style={{ width: '100%', margin: 0 }}>Add and verify an SMTP account above before activating.</p>
                )}
              </div>

              <div className="smtp-bar" style={{ marginTop: '0.5rem', display: 'block' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div className="smtp-bar-left">
                    <span className="smtp-bar-title">Login Password</span>
                  </div>
                  <div className="smtp-bar-actions">
                    <button type="button" className="btn primary" onClick={() => setShowPasswordChange(!showPasswordChange)}>
                      {showPasswordChange ? "Collapse" : "Expand"}
                    </button>
                  </div>
                </div>
                {showPasswordChange && (
                  <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--line)' }}>
                    <p className="hint compact" style={{ marginBottom: '0.75rem' }}>Update the password you use to log into Cuneihire.</p>
                    <form onSubmit={handlePasswordChange} className="grid-2" style={{ alignItems: "flex-end" }}>
                      <label className="field">
                        <span>New Password</span>
                        <input
                          type="password"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="Min 6 characters"
                          disabled={passwordLoading}
                        />
                      </label>
                      <button
                        type="submit"
                        className="btn primary"
                        disabled={passwordLoading || !newPassword}
                      >
                        {passwordLoading ? "Updating..." : "Update Password"}
                      </button>
                    </form>
                  </div>
                )}
              </div>
            </div>
          )}

          {showAutoFetch && (
            <AutoFetchModal
              config={autoFetch}
              onSave={setAutoFetch}
              roleDefs={roleDefs}
              onClose={() => setShowAutoFetch(false)}
            />
          )}

          {showSmtpModal && (
            <SmtpConfigPanel
              accounts={smtpAccounts}
              onSaveAccount={handleSaveSmtpAccount}
              onDeleteAccount={handleDeleteSmtpAccount}
              onResetAll={resetAll}
              onClose={() => setShowSmtpModal(false)}
            />
          )}
        </div>
      </main>
    </div>
  );
}
