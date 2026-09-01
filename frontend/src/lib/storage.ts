import { supabase } from "./supabase";
import {
  emptyResumeData,
  emptyCandidateProfile,
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
  type Attachment,
  type AutoFetchConfig,
  type AutomailConfig,
  type AiConfig,
  type CandidateProfile,
  type RecruiterProfile,
  type JobPosting,
  type JobApplication,
} from "@/lib/types";

export type PersistedState = {
  config: SmtpConfig;
  recipients: Recipient[];
  // A role's template/resume LIBRARY (2026-08-18) — was one row per role, now any number, one flagged
  // default, any subset flagged for randomization. See docs/architecture.md.
  templates: Record<Role, RoleTemplate[]>;
  resumes: Record<Role, ResumeEntry[]>;
  // Resume Builder profiles (2026-08-18) — structured, section-by-section resume data, distinct from the
  // `resumes` file library above. Not per-role — a user just keeps a flat list of their own resumes.
  resumeProfiles: ResumeProfile[];
  roleDefs: RoleDef[];
  smtpAccounts: SmtpAccount[];
  delaySec: number;
  activeTemplateRole: Role;
  defaultTitle: string;
  sentLog: SentRecord[];
  // Reply monitoring (2026-08-19) — read-only, populated by replyPoll.worker.js. See ReplyRecord.
  replies: ReplyRecord[];
  autoFetch: AutoFetchConfig;
  automail: AutomailConfig;
  // The AI tab (2026-08-18) — see AiConfig's comment in types.ts.
  ai: AiConfig;
  // Admin-granted, read-only from here. Set via the Admin Portal, never by the user themselves.
  aiCredits: number;
  // App credits (2026-08-31, MVP push) — the second currency, spent on EVERY send (not just AI-touched
  // ones). Admin-granted, read-only from here, same as aiCredits.
  appCredits: number;
  // Manual per-user overrides (2026-08-25) — the first lever toward real plan tiers, admin-set via
  // AdminPortal.tsx, read-only from here. null means "no override, behave exactly like every other
  // account" — see supabase_setup.sql's section for the full reasoning.
  maxKeywords: number | null;
  minFetchIntervalOverride: number | null;
  // Lemon Squeezy subscription (2026-08-31, foundation hardening) — webhook-granted, read-only from here,
  // same "not written back by saveAppState" precedent as aiCredits/appCredits above. planTier always has a
  // real value ('free' is genuine, not "unset"); subscriptionStatus/currentPeriodEndsAt are null only for
  // a free account that's never had a subscription at all.
  planTier: "free" | "starter" | "pro" | "elite";
  subscriptionStatus: string | null;
  currentPeriodEndsAt: string | null;
  // Tier-gated feature ceilings (2026-08-31, operator spec) — same read-only, webhook/admin-granted
  // precedent as planTier above; the frontend only ever reads these to gate UI, never writes them back.
  maxFollowUps: number;
  aiEmailWritingEnabled: boolean;
  replyMonitoringEnabled: boolean;
  // Open-source job sourcing via JobSpy/Indeed (2026-08-31) — opt-in, additive to autoFetch (the LinkedIn
  // scraper) above, not a replacement. Reuses each role's existing keywords/preferredLocations, no separate
  // config surface. See docs/architecture.md's "Open-source job sourcing" section.
  jobspySourcingEnabled: boolean;
  profile: CandidateProfile;
  batchSendPending: boolean;
};

export function defaultState(): PersistedState {
  return {
    config: { email: "", appPassword: "", fromName: "", configured: false },
    recipients: [],
    templates: {},
    resumes: {},
    resumeProfiles: [],
    roleDefs: [],
    smtpAccounts: [],
    delaySec: 3,
    activeTemplateRole: "fullstack",
    defaultTitle: "",
    sentLog: [],
    replies: [],
    autoFetch: {
      enabled: false,
      intervalMin: 5,
      paginationLimit: 5,
      paginationDelaySec: 10,
      liAt: "",
      jsessionid: "",
      rawHeaders: "{}",
      postAgeFilter: "any",
    },
    automail: {
      enabled: false,
      dailyLimit: 50,
      candidateInfo: "",
    },
    ai: {
      enabled: false,
      temperature: 0.4,
      matchStrictness: 0,
    },
    aiCredits: 0,
    appCredits: 0,
    maxKeywords: null,
    minFetchIntervalOverride: null,
    planTier: "free",
    subscriptionStatus: null,
    currentPeriodEndsAt: null,
    maxFollowUps: 3,
    aiEmailWritingEnabled: true,
    replyMonitoringEnabled: true,
    jobspySourcingEnabled: false,
    // Loaded/saved separately via loadCandidateProfile/saveCandidateProfile (its own table, own section
    // below) — not part of the app_state round trip any more. Kept here only as the field's shape default.
    profile: emptyCandidateProfile(),
    batchSendPending: false,
  };
}

export async function uploadAttachment(
  file: File,
  userId: string
): Promise<Attachment> {
  const fileExt = file.name.split(".").pop();
  const fileName = `${Math.random().toString(36).substring(2)}_${Date.now()}.${fileExt}`;
  const filePath = `${userId}/${fileName}`;

  const { error } = await supabase.storage
    .from("automailsend_attachments")
    .upload(filePath, file);

  if (error) {
    throw error;
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from("automailsend_attachments").getPublicUrl(filePath);

  return {
    id: fileName,
    name: file.name,
    type: file.type,
    url: publicUrl,
    storagePath: filePath,
    size: file.size,
  };
}

export async function deleteAttachment(filePath: string) {
  const { error } = await supabase.storage
    .from("automailsend_attachments")
    .remove([filePath]);
  if (error) throw error;
}

export async function loadState(userId: string): Promise<PersistedState> {
  const state = defaultState();

  // Load app state
  const { data: appState } = await supabase
    .from("automailsend_app_state")
    .select("*")
    .eq("user_id", userId)
    .single();

  if (appState) {
    const dbConfig = appState.config || {};
    state.config = {
      email: appState.smtp_email || "",
      appPassword: appState.smtp_password || "",
      fromEmail: dbConfig.fromEmail || "",
      fromName: dbConfig.fromName || "",
      provider: dbConfig.provider || "gmail",
      host: dbConfig.host || "smtp.gmail.com",
      port: parseInt(dbConfig.port || "465", 10),
      configured: !!appState.smtp_password,
    };
    state.delaySec = appState.send_delay_sec || 3;
    state.defaultTitle = appState.default_title || "";
    
    state.autoFetch = {
      enabled: appState.auto_fetch_enabled || false,
      intervalMin: appState.auto_fetch_interval_min || 5,
      paginationLimit: appState.auto_fetch_pagination_limit || 5,
      paginationDelaySec: appState.auto_fetch_pagination_delay_sec || 10,
      liAt: appState.cookie_li_at || "",
      jsessionid: appState.cookie_jsessionid || "",
      rawHeaders: appState.auto_fetch_raw_headers || "{}",
      postAgeFilter: (appState.post_age_filter as any) || "any",
    };
    
    state.automail = {
      enabled: appState.automail_enabled || false,
      dailyLimit: appState.daily_mail_limit || 50,
      candidateInfo: appState.candidate_info || "",
    };
    state.ai = {
      enabled: appState.ai_personalization_enabled || false,
      temperature: typeof appState.ai_temperature === "number" ? appState.ai_temperature : 0.4,
      matchStrictness: appState.ai_match_strictness || 0,
    };
    state.aiCredits = appState.ai_credits ?? 0;
    state.appCredits = appState.app_credits ?? 0;
    state.maxKeywords = appState.max_keywords ?? null;
    state.minFetchIntervalOverride = appState.min_fetch_interval_override ?? null;
    state.planTier = (appState.plan_tier as PersistedState["planTier"]) || "free";
    state.subscriptionStatus = appState.subscription_status ?? null;
    state.currentPeriodEndsAt = appState.current_period_ends_at ?? null;
    state.maxFollowUps = appState.max_follow_ups ?? 3;
    state.aiEmailWritingEnabled = appState.ai_email_writing_enabled !== false;
    state.replyMonitoringEnabled = appState.reply_monitoring_enabled !== false;
    state.jobspySourcingEnabled = appState.jobspy_sourcing_enabled || false;
    // profile is no longer read from app_state — see loadCandidateProfile below. The old candidate_*
    // columns here are left in place, unused, same precedent as every other superseded column this
    // project (delay_sec / old ai_prompt / app_state.config — see supabase_setup.sql section 27).
    state.batchSendPending = appState.batch_send_pending || false;
  }

  // Load recipients
  const { data: recipients } = await supabase
    .from("automailsend_recipients")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (recipients) {
    state.recipients = recipients.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role as Role,
      title: r.title,
      phone: r.phone,
      status: r.status || "pending",
      phone_status: r.phone_status || "pending",
      source: r.source || "auto_fetch",
      source_url: r.source_url,
      job_post_id: r.job_post_id,
      author_name: r.author_name || undefined,
      context_text: r.context_text || undefined,
      match_score: r.match_score ?? null,
      match_reasoning: r.match_reasoning || null,
      match_analyzed_at: r.match_analyzed_at || null,
      ai_summary: r.ai_summary || null,
      ai_summary_generated_at: r.ai_summary_generated_at || null,
      scraped_at: r.scraped_at,
      hasReplied: !!r.has_replied,
      repliedAt: r.replied_at || undefined,
      replyCount: r.reply_count || 0,
      lastSentAt: r.last_sent_at || undefined,
      followUpCount: r.follow_up_count || 0,
    }));
  }

  // Load templates — a library per role now (see PersistedState.templates), grouped by role instead of
  // overwriting one slot.
  const { data: templates } = await supabase
    .from("automailsend_templates")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (templates) {
    templates.forEach((t) => {
      const role = t.role as Role;
      (state.templates[role] = state.templates[role] || []).push(mapTemplateRow(t));
    });
  }

  // Load resumes — same library shape, files only.
  const { data: resumes } = await supabase
    .from("automailsend_resumes")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (resumes) {
    resumes.forEach((r) => {
      const role = r.role as Role;
      (state.resumes[role] = state.resumes[role] || []).push({
        id: r.id,
        role: r.role,
        label: r.label || "Resume",
        files: r.files as Attachment[],
        isDefault: !!r.is_default,
        inRandomizer: !!r.in_randomizer,
      });
    });
  }

  // Load Resume Builder profiles — flat list, not per-role.
  const { data: resumeProfiles } = await supabase
    .from("automailsend_resume_profiles")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (resumeProfiles) {
    state.resumeProfiles = resumeProfiles.map((p) => ({
      id: p.id,
      label: p.label || "My Resume",
      templateId: (p.template_id || "modern") as ResumeProfile["templateId"],
      data: { ...emptyResumeData(), ...(p.data || {}) },
    }));
  }

  // Load sent log
  const { data: sentLog } = await supabase
    .from("automailsend_sent_log")
    .select("*")
    .eq("user_id", userId)
    .order("sent_at", { ascending: false });
  if (sentLog) {
    state.sentLog = sentLog.map((s) => ({
      email: s.email,
      role: s.role as Role,
      title: s.title,
      subject: s.subject || undefined,
      body: s.body || undefined,
      status: s.status || "sent",
      error: s.error_message || undefined,
      sentAt: s.sent_at,
      templateLabel: s.template_label || undefined,
      resumeLabel: s.resume_label || undefined,
    }));
  }

  // Load replies (2026-08-19) — read-only, written by the backend's IMAP poller.
  const { data: replies } = await supabase
    .from("automailsend_replies")
    .select("*")
    .eq("user_id", userId)
    .order("received_at", { ascending: false });
  if (replies) {
    state.replies = replies.map((r) => ({
      id: r.id,
      recipientId: r.recipient_id || undefined,
      fromEmail: r.from_email,
      subject: r.subject || undefined,
      bodySnippet: r.body_snippet || undefined,
      receivedAt: r.received_at || r.created_at,
      matchMethod: (r.match_method as ReplyRecord["matchMethod"]) || undefined,
      messageId: r.message_id || undefined,
      smtpAccountId: r.smtp_account_id || undefined,
    }));
  }

  state.roleDefs = await ensureDefaultRoleDefs(userId);
  state.smtpAccounts = await loadSmtpAccounts(userId);

  return state;
}

// --- Role defs (user-managed job targets — keywords + rules, replacing the old hardcoded 4-value Role
// type; see the Jobs & Roles page). ---

function mapRoleDefRow(d: any): RoleDef {
  return {
    id: d.id,
    key: d.key,
    label: d.label,
    keywords: d.keywords || [],
    excludeKeywords: d.exclude_keywords || [],
    workMode: (d.work_mode as RoleDef["workMode"]) || "any",
    workModes: d.work_modes || [],
    salaryCurrency: d.salary_currency || "USD",
    salaryPeriod: (d.salary_period as RoleDef["salaryPeriod"]) || "annual",
    salaryMin: d.salary_min ?? null,
    salaryMax: d.salary_max ?? null,
    preferredLocations: d.preferred_locations || [],
    employmentType: (d.employment_type as RoleDef["employmentType"]) || "any",
    employmentTypes: d.employment_types || [],
    companySize: (d.company_size as RoleDef["companySize"]) || "any",
    companySizes: d.company_sizes || [],
    visaSponsorship: (d.visa_sponsorship as RoleDef["visaSponsorship"]) || "any",
    availability: (d.availability as RoleDef["availability"]) || "",
    otherNotes: d.other_notes || "",
    aiInstructions: d.ai_instructions || "",
    selectedExperienceIds: d.selected_experience_ids || [],
    selectedEducationIds: d.selected_education_ids || [],
    selectedProjectIds: d.selected_project_ids || [],
    selectedCertificationIds: d.selected_certification_ids || [],
    selectedSkillIds: d.selected_skill_ids || [],
    selectedFileIds: d.selected_file_ids || [],
    resumeId: d.resume_id ?? null,
    resumeMode: (d.resume_mode as RoleDef["resumeMode"]) || "profile",
    scratchResumeProfileId: d.scratch_resume_profile_id ?? null,
    emailSendMode: (d.email_send_mode as RoleDef["emailSendMode"]) || "manual",
    selectedTemplateId: d.selected_template_id ?? null,
    followUpIntervalDays: d.follow_up_interval_days ?? null,
    followUpTemplate1Id: d.follow_up_template_1_id ?? null,
    followUpTemplate2Id: d.follow_up_template_2_id ?? null,
    followUpTemplate3Id: d.follow_up_template_3_id ?? null,
  };
}

export async function loadRoleDefs(userId: string): Promise<RoleDef[]> {
  const { data } = await supabase
    .from("automailsend_role_defs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  return (data || []).map(mapRoleDefRow);
}

// A brand-new user has zero role defs — that's the intended starting state (2026-08-18: no more
// preloaded DevOps/Fullstack/AI Automation/Custom presets). Every role is built from scratch on the
// Jobs & Roles tab ("+ Add title"), which already has its own "No roles yet" empty state. This function
// is now just a thin alias kept so callers don't need to change; it seeds nothing.
export async function ensureDefaultRoleDefs(userId: string): Promise<RoleDef[]> {
  return loadRoleDefs(userId);
}

// Slugify a label into a role key, e.g. "Senior Rust Engineer" -> "senior-rust-engineer".
export function slugifyRoleKey(label: string): string {
  const base = label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `role-${Date.now()}`;
}

export async function saveRoleDef(
  userId: string,
  def: Partial<RoleDef> & { key: string; label: string }
): Promise<RoleDef | null> {
  if (def.id) {
    // Partial update — only touch columns actually passed in, so a rename-only call (or any other
    // partial call) never blanks out keywords/rules the caller didn't mean to change.
    const payload: Record<string, unknown> = { key: def.key, label: def.label };
    if (def.keywords !== undefined) payload.keywords = def.keywords;
    if (def.excludeKeywords !== undefined) payload.exclude_keywords = def.excludeKeywords;
    if (def.workMode !== undefined) payload.work_mode = def.workMode;
    if (def.workModes !== undefined) payload.work_modes = def.workModes;
    if (def.salaryCurrency !== undefined) payload.salary_currency = def.salaryCurrency;
    if (def.salaryPeriod !== undefined) payload.salary_period = def.salaryPeriod;
    if (def.salaryMin !== undefined) payload.salary_min = def.salaryMin;
    if (def.salaryMax !== undefined) payload.salary_max = def.salaryMax;
    if (def.preferredLocations !== undefined) payload.preferred_locations = def.preferredLocations;
    if (def.employmentType !== undefined) payload.employment_type = def.employmentType;
    if (def.employmentTypes !== undefined) payload.employment_types = def.employmentTypes;
    if (def.companySize !== undefined) payload.company_size = def.companySize;
    if (def.companySizes !== undefined) payload.company_sizes = def.companySizes;
    if (def.visaSponsorship !== undefined) payload.visa_sponsorship = def.visaSponsorship;
    if (def.availability !== undefined) payload.availability = def.availability;
    if (def.otherNotes !== undefined) payload.other_notes = def.otherNotes;
    if (def.aiInstructions !== undefined) payload.ai_instructions = def.aiInstructions;
    if (def.selectedExperienceIds !== undefined) payload.selected_experience_ids = def.selectedExperienceIds;
    if (def.selectedEducationIds !== undefined) payload.selected_education_ids = def.selectedEducationIds;
    if (def.selectedProjectIds !== undefined) payload.selected_project_ids = def.selectedProjectIds;
    if (def.selectedCertificationIds !== undefined) payload.selected_certification_ids = def.selectedCertificationIds;
    if (def.selectedSkillIds !== undefined) payload.selected_skill_ids = def.selectedSkillIds;
    if (def.selectedFileIds !== undefined) payload.selected_file_ids = def.selectedFileIds;
    if (def.resumeId !== undefined) payload.resume_id = def.resumeId;
    if (def.resumeMode !== undefined) payload.resume_mode = def.resumeMode;
    if (def.scratchResumeProfileId !== undefined) payload.scratch_resume_profile_id = def.scratchResumeProfileId;
    if (def.emailSendMode !== undefined) payload.email_send_mode = def.emailSendMode;
    if (def.selectedTemplateId !== undefined) payload.selected_template_id = def.selectedTemplateId;
    if (def.followUpIntervalDays !== undefined) payload.follow_up_interval_days = def.followUpIntervalDays;
    if (def.followUpTemplate1Id !== undefined) payload.follow_up_template_1_id = def.followUpTemplate1Id;
    if (def.followUpTemplate2Id !== undefined) payload.follow_up_template_2_id = def.followUpTemplate2Id;
    if (def.followUpTemplate3Id !== undefined) payload.follow_up_template_3_id = def.followUpTemplate3Id;

    const { data, error } = await supabase
      .from("automailsend_role_defs")
      .update(payload)
      .eq("id", def.id)
      .select("*")
      .single();
    if (error || !data) return null;
    return mapRoleDefRow(data);
  }
  const { data, error } = await supabase
    .from("automailsend_role_defs")
    .insert({
      user_id: userId,
      key: def.key,
      label: def.label,
      keywords: def.keywords ?? [],
      exclude_keywords: def.excludeKeywords ?? [],
      work_mode: def.workMode ?? "any",
      work_modes: def.workModes ?? [],
      salary_currency: def.salaryCurrency ?? "USD",
      salary_period: def.salaryPeriod ?? "annual",
      salary_min: def.salaryMin ?? null,
      salary_max: def.salaryMax ?? null,
      preferred_locations: def.preferredLocations ?? [],
      employment_type: def.employmentType ?? "any",
      employment_types: def.employmentTypes ?? [],
      company_size: def.companySize ?? "any",
      company_sizes: def.companySizes ?? [],
      visa_sponsorship: def.visaSponsorship ?? "any",
      availability: def.availability ?? "",
      other_notes: def.otherNotes ?? "",
      ai_instructions: def.aiInstructions ?? "",
      // Defaults to "everything selected" is the caller's job (it's the one holding the candidate's
      // current profile item ids at role-creation time — see page.tsx's handleAddRole) — this just
      // respects whatever's passed, empty if nothing was.
      selected_experience_ids: def.selectedExperienceIds ?? [],
      selected_education_ids: def.selectedEducationIds ?? [],
      selected_project_ids: def.selectedProjectIds ?? [],
      selected_certification_ids: def.selectedCertificationIds ?? [],
      selected_skill_ids: def.selectedSkillIds ?? [],
      selected_file_ids: def.selectedFileIds ?? [],
      // Omitted entirely at role-creation time (see page.tsx's handleAddRole) — defaults to null, i.e.
      // "inherit the candidate's global default resume," the correct forgiving default here too.
      resume_id: def.resumeId ?? null,
      resume_mode: def.resumeMode ?? "profile",
      scratch_resume_profile_id: def.scratchResumeProfileId ?? null,
      email_send_mode: def.emailSendMode ?? "manual",
      selected_template_id: def.selectedTemplateId ?? null,
    })
    .select("*")
    .single();
  if (error || !data) return null;
  return mapRoleDefRow(data);
}

export async function deleteRoleDef(id: string) {
  const { error } = await supabase.from("automailsend_role_defs").delete().eq("id", id);
  if (error) throw error;
}

// --- SMTP accounts (a pool of mailboxes, replacing the single SmtpConfig as the source of truth for sending) ---

function mapSmtpAccountRow(a: any): SmtpAccount {
  return {
    id: a.id,
    label: a.label || "",
    provider: a.provider || "gmail",
    email: a.email,
    appPassword: a.app_password,
    host: a.host || "smtp.gmail.com",
    port: a.port || 465,
    fromEmail: a.from_email || "",
    fromName: a.from_name || "",
    dailyLimit: a.daily_limit || 50,
    isVerified: !!a.is_verified,
    isActive: a.is_active !== false,
    imapEnabled: !!a.imap_enabled,
    imapHost: a.imap_host || undefined,
    imapPort: a.imap_port || 993,
  };
}

export async function loadSmtpAccounts(userId: string): Promise<SmtpAccount[]> {
  const { data } = await supabase
    .from("automailsend_smtp_accounts")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  return (data || []).map(mapSmtpAccountRow);
}

export async function saveSmtpAccount(
  userId: string,
  account: Partial<SmtpAccount> & { id?: string; email: string; appPassword: string }
): Promise<SmtpAccount | null> {
  const payload = {
    label: account.label ?? "",
    provider: account.provider ?? "gmail",
    email: account.email,
    app_password: account.appPassword,
    host: account.host ?? "smtp.gmail.com",
    port: account.port ?? 465,
    from_email: account.fromEmail ?? "",
    from_name: account.fromName ?? "",
    daily_limit: account.dailyLimit ?? 50,
    is_verified: account.isVerified ?? false,
    is_active: account.isActive ?? true,
    imap_enabled: account.imapEnabled ?? false,
    imap_host: account.imapHost ?? null,
    imap_port: account.imapPort ?? 993,
  };
  if (account.id) {
    const { data, error } = await supabase
      .from("automailsend_smtp_accounts")
      .update(payload)
      .eq("id", account.id)
      .select("*")
      .single();
    if (error || !data) return null;
    return mapSmtpAccountRow(data);
  }
  const { data, error } = await supabase
    .from("automailsend_smtp_accounts")
    .insert({ user_id: userId, ...payload })
    .select("*")
    .single();
  if (error || !data) return null;
  return mapSmtpAccountRow(data);
}

export async function deleteSmtpAccount(id: string) {
  const { error } = await supabase.from("automailsend_smtp_accounts").delete().eq("id", id);
  if (error) throw error;
}

export async function saveAppState(userId: string, state: PersistedState) {
  // Update app_state
  await supabase.from("automailsend_app_state").upsert(
    {
      user_id: userId,
      smtp_email: state.config.email,
      smtp_password: state.config.appPassword,
      config: state.config,
      send_delay_sec: state.delaySec,
      active_template_role: state.activeTemplateRole,
      default_title: state.defaultTitle,
      auto_fetch_enabled: state.autoFetch.enabled,
      jobspy_sourcing_enabled: state.jobspySourcingEnabled,
      auto_fetch_interval_min: state.autoFetch.intervalMin,
      auto_fetch_pagination_limit: state.autoFetch.paginationLimit,
      auto_fetch_pagination_delay_sec: state.autoFetch.paginationDelaySec,
      cookie_li_at: state.autoFetch.liAt,
      cookie_jsessionid: state.autoFetch.jsessionid,
      auto_fetch_raw_headers: state.autoFetch.rawHeaders,
      post_age_filter: state.autoFetch.postAgeFilter,
      automail_enabled: state.automail.enabled,
      daily_mail_limit: state.automail.dailyLimit,
      ai_personalization_enabled: state.ai.enabled,
      ai_temperature: state.ai.temperature,
      ai_match_strictness: state.ai.matchStrictness,
      candidate_info: state.automail.candidateInfo,
      // profile fields no longer written here — see saveCandidateProfile (its own table now).
    },
    { onConflict: "user_id" }
  );
}

// --- Email template library (2026-08-18: real per-row CRUD now that a role can have many, not one —
// same shape as saveRoleDef/deleteRoleDef above) ---

function mapTemplateRow(t: any): RoleTemplate {
  return {
    id: t.id,
    label: t.label || "Default",
    subject: t.subject || "",
    content: t.content || "",
    files: (t.files || []) as Attachment[],
    isDefault: !!t.is_default,
    inRandomizer: !!t.in_randomizer,
  };
}

export async function saveTemplate(
  userId: string,
  role: Role,
  template: Partial<RoleTemplate> & { id?: string }
): Promise<RoleTemplate | null> {
  const payload: Record<string, unknown> = {};
  if (template.label !== undefined) payload.label = template.label;
  if (template.subject !== undefined) payload.subject = template.subject;
  if (template.content !== undefined) payload.content = template.content;
  if (template.files !== undefined) payload.files = template.files;
  if (template.inRandomizer !== undefined) payload.in_randomizer = template.inRandomizer;

  if (template.id) {
    const { data, error } = await supabase
      .from("automailsend_templates")
      .update(payload)
      .eq("id", template.id)
      .select("*")
      .single();
    if (error || !data) return null;
    return mapTemplateRow(data);
  }
  const { data, error } = await supabase
    .from("automailsend_templates")
    .insert({ user_id: userId, role, ...payload })
    .select("*")
    .single();
  if (error || !data) return null;
  return mapTemplateRow(data);
}

export async function deleteTemplate(id: string) {
  const { error } = await supabase.from("automailsend_templates").delete().eq("id", id);
  if (error) throw error;
}

// Unsets every other template for the role, then sets this one — two calls, not a transaction, but the
// only writer is the signed-in user themself so there's no real concurrency risk here.
export async function setDefaultTemplate(userId: string, role: Role, id: string) {
  await supabase.from("automailsend_templates").update({ is_default: false }).eq("user_id", userId).eq("role", role);
  const { error } = await supabase.from("automailsend_templates").update({ is_default: true }).eq("id", id);
  if (error) throw error;
}

// --- Resume library (deliberately separate from templates — see docs/architecture.md) ---

function mapResumeRow(r: any): ResumeEntry {
  return {
    id: r.id,
    role: r.role,
    label: r.label || "Resume",
    files: (r.files || []) as Attachment[],
    isDefault: !!r.is_default,
    inRandomizer: !!r.in_randomizer,
  };
}

export async function saveResume(
  userId: string,
  role: Role,
  resume: Partial<ResumeEntry> & { id?: string }
): Promise<ResumeEntry | null> {
  const payload: Record<string, unknown> = {};
  if (resume.label !== undefined) payload.label = resume.label;
  if (resume.files !== undefined) payload.files = resume.files;
  if (resume.inRandomizer !== undefined) payload.in_randomizer = resume.inRandomizer;

  if (resume.id) {
    const { data, error } = await supabase
      .from("automailsend_resumes")
      .update(payload)
      .eq("id", resume.id)
      .select("*")
      .single();
    if (error || !data) return null;
    return mapResumeRow(data);
  }
  const { data, error } = await supabase
    .from("automailsend_resumes")
    .insert({ user_id: userId, role, ...payload })
    .select("*")
    .single();
  if (error || !data) return null;
  return mapResumeRow(data);
}

export async function deleteResume(id: string) {
  const { error } = await supabase.from("automailsend_resumes").delete().eq("id", id);
  if (error) throw error;
}

export async function setDefaultResume(userId: string, role: Role, id: string) {
  await supabase.from("automailsend_resumes").update({ is_default: false }).eq("user_id", userId).eq("role", role);
  const { error } = await supabase.from("automailsend_resumes").update({ is_default: true }).eq("id", id);
  if (error) throw error;
}

// --- Resume Builder profiles (2026-08-18) — structured resume data, distinct from the file library
// above. Flat per-user list, not per-role. Same per-row CRUD shape as everything else in this file. ---

export async function saveResumeProfile(
  userId: string,
  profile: Partial<ResumeProfile> & { id?: string }
): Promise<ResumeProfile | null> {
  const payload: Record<string, unknown> = {};
  if (profile.label !== undefined) payload.label = profile.label;
  if (profile.templateId !== undefined) payload.template_id = profile.templateId;
  if (profile.data !== undefined) payload.data = profile.data;

  if (profile.id) {
    const { data, error } = await supabase
      .from("automailsend_resume_profiles")
      .update(payload)
      .eq("id", profile.id)
      .select("*")
      .single();
    if (error || !data) return null;
    return {
      id: data.id,
      label: data.label || "My Resume",
      templateId: (data.template_id || "modern") as ResumeProfile["templateId"],
      data: { ...emptyResumeData(), ...(data.data || {}) },
    };
  }
  const { data, error } = await supabase
    .from("automailsend_resume_profiles")
    .insert({ user_id: userId, ...payload })
    .select("*")
    .single();
  if (error || !data) return null;
  return {
    id: data.id,
    label: data.label || "My Resume",
    templateId: (data.template_id || "modern") as ResumeProfile["templateId"],
    data: { ...emptyResumeData(), ...(data.data || {}) },
  };
}

export async function deleteResumeProfile(id: string) {
  const { error } = await supabase.from("automailsend_resume_profiles").delete().eq("id", id);
  if (error) throw error;
}

export async function syncRecipients(userId: string, recipients: Recipient[]) {
  if (recipients.length === 0) return;
  const { error } = await supabase.from("automailsend_recipients").upsert(
    recipients.map((r) => ({
      id: r.id,
      user_id: userId,
      email: r.email,
      role: r.role,
      title: r.title,
      phone: r.phone || null,
      status: r.status || 'pending',
      source: r.source || 'manual',
    })),
    { onConflict: 'id' }
  );
  if (error) {
    console.error("Failed to sync recipients:", error.message, error.details, error.hint, error.code, error);
  }
}

export async function deleteRecipient(id: string) {
  const { error } = await supabase.from("automailsend_recipients").delete().eq("id", id);
  if (error) throw error;
}

export async function addSentLog(
  userId: string,
  record: SentRecord
) {
  await supabase.from("automailsend_sent_log").insert({
    user_id: userId,
    email: record.email,
    role: record.role,
    title: record.title,
    subject: record.subject || null,
    body: record.body || null,
    status: record.status,
    error_message: record.error || null,
    sent_at: record.sentAt,
    template_label: record.templateLabel || null,
    resume_label: record.resumeLabel || null,
    send_stage: "initial",
  });

  // Also update the recipient's status so the UI reflects it immediately. Follow-up scheduling fields only
  // set on an actual send — a failed/skipped Quick Send starts no follow-up clock (2026-08-31).
  const recipientUpdate: Record<string, unknown> = { status: record.status };
  if (record.status === "sent") {
    recipientUpdate.last_sent_at = record.sentAt;
    recipientUpdate.next_follow_up_at = record.nextFollowUpAt ?? null;
  }
  await supabase.from("automailsend_recipients")
    .update(recipientUpdate)
    .eq("user_id", userId)
    .eq("email", record.email);
}

// --- Candidate profile (2026-08-19) — the permanent knowledge base a role's module selection draws from
// (see lib/resumeCompose.ts, RoleDef's comment in types.ts). Unlike RecruiterProfile, whose null-ness is
// meaningful ("not activated yet"), every candidate has one profile — a missing row just means it hasn't
// been saved yet, so loading returns sensible empty defaults rather than null. ---

function mapCandidateProfileRow(p: any): CandidateProfile {
  return {
    name: p.name || "",
    email: p.email || "",
    phone: p.phone || "",
    address: p.address || "",
    bio: p.bio || "",
    portfolioUrl: p.portfolio_url || "",
    resumeUrl: p.resume_url || "",
    education: p.education || [],
    experience: p.experience || [],
    projects: p.projects || [],
    certifications: p.certifications || [],
    skills: p.skills || [],
    languages: p.languages || [],
    // global_files (2026-08-19) — repurposed, not renamed: was a single "global default" list, is now
    // the candidate's whole files pool, with each role picking its own subset (RoleDef.selectedFileIds).
    // See docs/architecture.md's "Email Templates redesign" section.
    files: p.global_files || [],
    // global_resume_id (2026-08-20) — which pool entry is the default resume; see RoleDef.resumeId.
    globalResumeId: p.global_resume_id ?? null,
  };
}

export async function loadCandidateProfile(userId: string): Promise<CandidateProfile> {
  const { data } = await supabase
    .from("automailsend_candidate_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return data ? mapCandidateProfileRow(data) : emptyCandidateProfile();
}

// Upsert rather than update — the row may not exist yet if this is the candidate's first save.
export async function saveCandidateProfile(
  userId: string,
  profile: CandidateProfile
): Promise<CandidateProfile | null> {
  const { data, error } = await supabase
    .from("automailsend_candidate_profiles")
    .upsert(
      {
        user_id: userId,
        name: profile.name,
        email: profile.email,
        phone: profile.phone,
        address: profile.address,
        bio: profile.bio,
        portfolio_url: profile.portfolioUrl,
        resume_url: profile.resumeUrl,
        education: profile.education,
        experience: profile.experience,
        projects: profile.projects,
        certifications: profile.certifications,
        skills: profile.skills,
        languages: profile.languages,
        global_files: profile.files,
        global_resume_id: profile.globalResumeId,
      },
      { onConflict: "user_id" }
    )
    .select("*")
    .single();
  if (error || !data) return null;
  return mapCandidateProfileRow(data);
}

// --- Recruiter portal + AI-assisted ATS (2026-08-19) — see docs/architecture.md ---

function mapRecruiterProfileRow(p: any): RecruiterProfile {
  return {
    userId: p.user_id,
    companyName: p.company_name || "",
    atsAiEnabled: !!p.ats_ai_enabled,
    atsAiCredits: p.ats_ai_credits ?? 0,
  };
}

// Null means the user hasn't activated recruiter mode yet — distinct from a profile with everything at
// defaults, so callers can tell "never activated" from "activated, nothing configured yet".
export async function loadRecruiterProfile(userId: string): Promise<RecruiterProfile | null> {
  const { data } = await supabase
    .from("automailsend_recruiter_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return data ? mapRecruiterProfileRow(data) : null;
}

// Self-serve "Become a Recruiter" — immediate, no approval, matches this app's existing self-serve model.
export async function becomeRecruiter(userId: string): Promise<RecruiterProfile | null> {
  const { data, error } = await supabase
    .from("automailsend_recruiter_profiles")
    .insert({ user_id: userId })
    .select("*")
    .single();
  if (error || !data) return null;
  return mapRecruiterProfileRow(data);
}

export async function saveRecruiterProfile(
  userId: string,
  updates: Partial<Pick<RecruiterProfile, "companyName" | "atsAiEnabled">>
): Promise<RecruiterProfile | null> {
  const payload: Record<string, unknown> = {};
  if (updates.companyName !== undefined) payload.company_name = updates.companyName;
  if (updates.atsAiEnabled !== undefined) payload.ats_ai_enabled = updates.atsAiEnabled;

  const { data, error } = await supabase
    .from("automailsend_recruiter_profiles")
    .update(payload)
    .eq("user_id", userId)
    .select("*")
    .single();
  if (error || !data) return null;
  return mapRecruiterProfileRow(data);
}

function mapJobPostingRow(p: any): JobPosting {
  return {
    id: p.id,
    recruiterId: p.recruiter_id,
    title: p.title,
    company: p.company || "",
    description: p.description || "",
    location: p.location || "",
    workMode: (p.work_mode as JobPosting["workMode"]) || "any",
    employmentType: (p.employment_type as JobPosting["employmentType"]) || "full-time",
    salaryCurrency: p.salary_currency || "USD",
    salaryPeriod: (p.salary_period as JobPosting["salaryPeriod"]) || "annual",
    salaryMin: p.salary_min ?? null,
    salaryMax: p.salary_max ?? null,
    status: (p.status as JobPosting["status"]) || "open",
    createdAt: p.created_at,
  };
}

// Every OPEN posting from every recruiter — the candidate-facing Job Board. RLS already scopes this to
// `status = 'open' or auth.uid() = recruiter_id`, so this select naturally can't leak a closed posting
// that isn't the caller's own.
export async function loadOpenJobPostings(): Promise<JobPosting[]> {
  const { data } = await supabase
    .from("automailsend_job_postings")
    .select("*")
    .eq("status", "open")
    .order("created_at", { ascending: false });
  return (data || []).map(mapJobPostingRow);
}

export async function loadMyJobPostings(userId: string): Promise<JobPosting[]> {
  const { data } = await supabase
    .from("automailsend_job_postings")
    .select("*")
    .eq("recruiter_id", userId)
    .order("created_at", { ascending: false });
  return (data || []).map(mapJobPostingRow);
}

export async function saveJobPosting(
  recruiterId: string,
  posting: Partial<JobPosting> & { id?: string; title: string; description: string }
): Promise<JobPosting | null> {
  const payload: Record<string, unknown> = {
    title: posting.title,
    description: posting.description,
  };
  if (posting.company !== undefined) payload.company = posting.company;
  if (posting.location !== undefined) payload.location = posting.location;
  if (posting.workMode !== undefined) payload.work_mode = posting.workMode;
  if (posting.employmentType !== undefined) payload.employment_type = posting.employmentType;
  if (posting.salaryCurrency !== undefined) payload.salary_currency = posting.salaryCurrency;
  if (posting.salaryPeriod !== undefined) payload.salary_period = posting.salaryPeriod;
  if (posting.salaryMin !== undefined) payload.salary_min = posting.salaryMin;
  if (posting.salaryMax !== undefined) payload.salary_max = posting.salaryMax;
  if (posting.status !== undefined) payload.status = posting.status;

  if (posting.id) {
    const { data, error } = await supabase
      .from("automailsend_job_postings")
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq("id", posting.id)
      .select("*")
      .single();
    if (error || !data) return null;
    return mapJobPostingRow(data);
  }
  const { data, error } = await supabase
    .from("automailsend_job_postings")
    .insert({ recruiter_id: recruiterId, ...payload })
    .select("*")
    .single();
  if (error || !data) return null;
  return mapJobPostingRow(data);
}

export async function setJobPostingStatus(id: string, status: JobPosting["status"]) {
  const { error } = await supabase
    .from("automailsend_job_postings")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw error;
}

export async function deleteJobPosting(id: string) {
  const { error } = await supabase.from("automailsend_job_postings").delete().eq("id", id);
  if (error) throw error;
}

function mapJobApplicationRow(a: any): JobApplication {
  return {
    id: a.id,
    jobId: a.job_id,
    candidateId: a.candidate_id,
    candidateName: a.candidate_name || "",
    candidateEmail: a.candidate_email || "",
    candidatePhone: a.candidate_phone || "",
    coverNote: a.cover_note || "",
    resumeData: a.resume_data ? { ...emptyResumeData(), ...a.resume_data } : null,
    resumeFileUrl: a.resume_file_url || undefined,
    resumeFileName: a.resume_file_name || undefined,
    status: (a.status as JobApplication["status"]) || "submitted",
    aiScore: a.ai_score ?? null,
    aiReasoning: a.ai_reasoning || null,
    aiAnalyzedAt: a.ai_analyzed_at || null,
    createdAt: a.created_at,
  };
}

// Applications are only ever INSERTed via /api/jobs/apply (service-role key, AI-credit spend must be
// server-verified) — storage.ts only reads and updates status from here.
export async function loadApplicationsForCandidate(userId: string): Promise<JobApplication[]> {
  const { data } = await supabase
    .from("automailsend_job_applications")
    .select("*")
    .eq("candidate_id", userId)
    .order("created_at", { ascending: false });
  return (data || []).map(mapJobApplicationRow);
}

export async function loadApplicationsForPosting(jobId: string): Promise<JobApplication[]> {
  const { data } = await supabase
    .from("automailsend_job_applications")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: false });
  return (data || []).map(mapJobApplicationRow);
}

export async function updateApplicationStatus(id: string, status: JobApplication["status"]) {
  const { error } = await supabase
    .from("automailsend_job_applications")
    .update({ status })
    .eq("id", id);
  if (error) throw error;
}
