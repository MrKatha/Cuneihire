// `role` used to be a hardcoded 4-value union (devops/fullstack/ai-automation/custom). It's now a free-text
// key into a user-managed list of RoleDefs (see automailsend_role_defs / storage.ts's loadRoleDefs) so
// people can target any job title, not just the original four. Kept as a named alias (rather than inlining
// `string` everywhere) so the many existing `role: Role` annotations across this file didn't need touching.
export type Role = string;

// Legacy single-select value (2026-08-17) — retired from the UI 2026-08-26 in favor of RoleDef.workModes
// below, a pill multi-select ("I could be open to multiple types of work modes" — operator ask, same pass
// as companySizes/employmentTypes below). Kept on the type/schema, never dropped — same "superseded, never
// dropped" precedent as every other retired field in this project (see RoleDef.selectedFileIds).
export type WorkMode = "remote" | "onsite" | "hybrid" | "any";
export type WorkModeOption = Exclude<WorkMode, "any">;
export const WORK_MODE_OPTIONS: { value: WorkModeOption; label: string }[] = [
  { value: "remote", label: "Remote" },
  { value: "onsite", label: "On-site" },
  { value: "hybrid", label: "Hybrid" },
];

export type SalaryPeriod = "hourly" | "monthly" | "annual";

// Legacy single-select (2026-08-17) — retired from the UI 2026-08-26 in favor of RoleDef.employmentTypes
// below ("I could be open to multiple types of employment" — operator ask). Same retirement precedent.
export type EmploymentType = "full-time" | "part-time" | "contract" | "internship" | "any";
export type EmploymentTypeOption = Exclude<EmploymentType, "any">;
export const EMPLOYMENT_TYPE_OPTIONS: { value: EmploymentTypeOption; label: string }[] = [
  { value: "full-time", label: "Full-time" },
  { value: "part-time", label: "Part-time" },
  { value: "contract", label: "Contract" },
  { value: "internship", label: "Internship" },
];

// Legacy single-select value (2026-08-17) — retired from the UI 2026-08-26 in favor of RoleDef.companySizes
// below, a pill multi-select ("select multiple company sizes... or skip enterprise" — operator ask). Kept
// on the type/schema, never dropped — same "superseded, never dropped" precedent as every other retired
// field in this project (see RoleDef.selectedFileIds).
export type CompanySize = "startup" | "small" | "medium" | "large" | "enterprise" | "any";
// The real, pickable values a candidate can pick for RoleDef.companySizes — "any" isn't one of them since
// an empty array already means "no restriction," same convention as excludeKeywords.
export type CompanySizeOption = Exclude<CompanySize, "any">;
export const COMPANY_SIZE_OPTIONS: { value: CompanySizeOption; label: string }[] = [
  { value: "startup", label: "Startup" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "enterprise", label: "Enterprise" },
];
export type VisaSponsorship = "required" | "not-required" | "any";

export type AvailabilityOption = "" | "immediate" | "2-weeks" | "1-month" | "3-plus-months";
export const AVAILABILITY_OPTIONS: { value: AvailabilityOption; label: string }[] = [
  { value: "", label: "Not specified" },
  { value: "immediate", label: "Immediately" },
  { value: "2-weeks", label: "2 weeks notice" },
  { value: "1-month", label: "1 month notice" },
  { value: "3-plus-months", label: "3+ months" },
];

// A role is now a full job target, not just a label: its own search keywords/aliases plus job-search
// "rules" — set together on the Jobs & Roles page. Email templates stay separate (RoleTemplates.tsx).
// Deliberately fixed-option over free text wherever there's a common, enumerable set of choices (operator
// directive, 2026-08-17) — keeps the fields the AI/matching logic consume consistent, and cheaper to
// reason about, than open text. `otherNotes` was the one deliberate catch-all for the long tail; retired
// from the UI 2026-08-26 (confirmed it never actually reached the AI matcher or resume composer).
//
// Module selection (2026-08-19) — a role also carries which of the candidate's CandidateProfile items
// (by id) get pulled into a resume composed for this role (see lib/resumeCompose.ts's composeResumeData).
// Most people target one role; this is the "slight chance of multiple roles" the operator called out, so
// each role keeps its own hand-picked subset of the one permanent profile rather than the profile itself
// forking per role. Defaults to "everything selected" when a role is created — the forgiving default, a
// candidate trims a role down rather than starting from a resume missing something they forgot to add.
// `languages` is deliberately not selectable per-role — always carried through whole.
// Email send mode (2026-08-19, replaces per-template randomization — see docs/architecture.md's "Email
// Templates redesign" section). Lives on the role, not a template, because a role already owns its own
// template pool (role-tabbed in RoleTemplates.tsx) and a role is what a job posting matches against.
// Set on the Email Templates tab's "Configuration" sub-tab (2026-08-20), separate from the "Templates"
// sub-tab that owns the wording itself.
// A third "let AI write the whole email, no template" mode was built, dropped the same day for
// simplicity, then restored 2026-08-20 per operator ask — back to all three:
//  - "manual": always sends `selectedTemplateId`, explicitly chosen by the candidate. No AI involved.
//  - "ai-select": AI picks the best-fit template from THIS ROLE'S OWN template pool per job — a
//    classification call, never generation, so the templates (100% user-written) are never altered.
//    Falls back to the pool's first template if AI is off/out of credits/errors.
//  - "ai-write": no template at all — AI writes subject+body from scratch using candidate info (My
//    Profile) and the job post. Skips the recipient (not a silent broken send) if AI is off/out of
//    credits — see automail.worker.js/batchSend.worker.js.
export type EmailSendMode = "manual" | "ai-select" | "ai-write";
export const EMAIL_SEND_MODES: { value: EmailSendMode; label: string; hint: string }[] = [
  { value: "manual", label: "Manual", hint: "You pick the template below. Always sent exactly as written." },
  { value: "ai-select", label: "Let AI choose", hint: "AI picks the best-fit template from your own for each job — it only chooses, never rewrites." },
  { value: "ai-write", label: "Let AI write it", hint: "No template — AI writes the whole email from your candidate info and the job post." },
];

export type RoleDef = {
  id: string;
  key: string;
  label: string;
  // "Include Keywords" (2026-08-25 label — same field as always). What actually gets searched in
  // LinkedIn's own search bar, one query per keyword (backend/src/workers/scraper.worker.js). Also read
  // by the AI as positive signal when scoring a scraped post — see ai.service.js's scoreJobMatch.
  keywords: string[];
  // "Exclude Keywords" (2026-08-25, operator ask — "the keywords that I do not want inside the job").
  // Never used to build a LinkedIn search query (there's no "exclude" search operator in play here) — this
  // is purely an AI-filtering signal: scoreJobMatch scores a post low when its own text is genuinely about
  // one of these, even though the post surfaced from an Include Keyword search. Existing rows default to
  // an empty list (nothing excluded), unchanged behavior.
  excludeKeywords: string[];
  // Legacy single-select — no longer read by the UI or the AI matcher, see WorkMode's comment above.
  workMode: WorkMode;
  // Multi-select work mode (2026-08-26, operator ask — "I could be open to multiple types of work
  // modes"). Empty array = no restriction, same "empty means unset" convention as excludeKeywords.
  workModes: WorkModeOption[];
  salaryCurrency: string;
  salaryPeriod: SalaryPeriod;
  salaryMin: number | null;
  salaryMax: number | null;
  // Countries/regions — a keyword-chip list, same add/remove UX as `keywords`, just a separate list
  // (work-mode already covers remote/on-site/hybrid; this is purely geography).
  preferredLocations: string[];
  // Legacy single-select — no longer read by the UI or the AI matcher, see EmploymentType's comment above.
  employmentType: EmploymentType;
  // Multi-select employment type (2026-08-26, operator ask — "I could be open to multiple types of
  // employment"). Empty array = no restriction, same convention as workModes/companySizes.
  employmentTypes: EmploymentTypeOption[];
  // Legacy single-select — no longer read by the UI or the AI matcher, see CompanySize's comment above.
  companySize: CompanySize;
  // Multi-select company size (2026-08-26, operator ask — "if I want to select multiple company sizes,
  // like startup, medium, or large, or I want to skip enterprise, I need to have that"). Pill UI, same
  // pattern as Preferred countries/locations below (2026-08-26 follow-up — "I wanted it to be similar to
  // the country pill"). Empty array = no restriction (matches on any company size), same "empty means
  // unset" convention as excludeKeywords.
  companySizes: CompanySizeOption[];
  visaSponsorship: VisaSponsorship;
  availability: AvailabilityOption;
  // Retired from the Roles UI (2026-08-26, operator ask — never actually read by the AI matcher or resume
  // composer, confirmed dead). Kept on the type/schema, never dropped, same precedent as CompanySize above
  // — any value an existing role already has just stops being shown or editable.
  otherNotes: string;
  // "This prompt is for AI" (2026-08-25, operator ask) — free text read directly by scoreJobMatch's
  // prompt, e.g. "Only match low-code/no-code roles" or "exclude unpaid internships even if the keywords
  // otherwise match." Takes priority over both the structured criteria above and Exclude Keywords when
  // they conflict — see ai.service.js's JOB_MATCH_SYSTEM_PROMPT. Distinct from `otherNotes`, which is
  // never sent to the AI matcher (resume/email context only) — this field exists specifically so it's
  // unambiguous which box actually reaches the model.
  aiInstructions: string;
  selectedExperienceIds: string[];
  selectedEducationIds: string[];
  selectedProjectIds: string[];
  selectedCertificationIds: string[];
  selectedSkillIds: string[];
  // "Additional files" a role attached alongside its one resume (2026-08-19, narrowed 2026-08-20, removed
  // 2026-08-20 same day per operator ask) — a role's send now attaches its resume only. Retired, unread
  // by anything (lib/emailResolve.ts's resolveRoleAttachments no longer consults it) — kept on the type/
  // schema, never dropped, same "superseded, never dropped" precedent as every other retired field in
  // this project, in case the feature is wanted again later.
  selectedFileIds: string[];
  // This role's one resume (2026-08-20) — an Attachment.id from CandidateProfile.files, or null to
  // inherit CandidateProfile.globalResumeId (the forgiving default: a brand-new role automatically uses
  // whatever the candidate already set as their global resume, no extra config needed). Set explicitly
  // here only to override the global one for this specific role. A stale/deleted id resolves to "no
  // resume" (unknown isn't a fail), same tolerance as selectedTemplateId. See lib/emailResolve.ts's
  // resolveRoleResume.
  resumeId: string | null;
  // Resume Builder redesign (2026-08-20, same-day follow-up) — which of the three authoring modes the
  // Builder tab's role view is showing/last used for this role. Pure UI state: never read at send time —
  // resumeId (above) is still the only thing resolveRoleResume looks at, whichever mode produced it.
  //  - "profile": the default — a resume composed live from the candidate's profile + this role's own
  //    selected*Ids, editable in place (see lib/resumeCompose.ts's composeResumeData).
  //  - "scratch": an ordinary hand-built resume with no profile linkage (see scratchResumeProfileId).
  //  - "upload": resumeId points at a directly-uploaded file, no ResumeProfile involved.
  resumeMode: "profile" | "scratch" | "upload";
  // Only meaningful in "scratch" mode — this role's one "start from scratch" ResumeProfile, if the
  // candidate has started one, so reopening that mode resumes the same draft instead of starting over or
  // picking from the flat ResumeProfile list (which JobBoardTab's Easy Apply also uses — left untouched).
  // A stale/deleted id is treated as "no scratch draft yet" (unknown isn't a fail), same tolerance as
  // every other id pointer in this type.
  scratchResumeProfileId: string | null;
  emailSendMode: EmailSendMode;
  // Only meaningful when emailSendMode === "manual". A stale/deleted id is treated as "none selected"
  // (unknown isn't a fail) rather than guessed — see automail.worker.js's resolveEmailForRecipient.
  selectedTemplateId: string | null;
  // Automated follow-ups (2026-08-31, MVP push) — null/unset means follow-ups are off for this role, same
  // "nullable means unset" idiom as selectedTemplateId/resumeId. A positive integer = days between each of
  // up to 3 follow-ups (see followUp.worker.js). Each followUpTemplateNId is independently nullable: null =
  // AI writes that slot (the default), set = that exact template is sent verbatim, no AI involved — same
  // "manual" semantics as emailSendMode.
  followUpIntervalDays: number | null;
  followUpTemplate1Id: string | null;
  followUpTemplate2Id: string | null;
  followUpTemplate3Id: string | null;
};

export const SALARY_CURRENCIES = ["USD", "EUR", "GBP", "PKR", "INR", "AED", "CAD", "AUD"] as const;

export type Recipient = {
  id: string;
  email: string;
  role: Role;
  title: string;
  phone?: string;
  status?: "pending" | "sent" | "failed";
  phone_status?: "pending" | "sent" | "wrong_number";
  source?: "auto_fetch" | "manual";
  source_url?: string;
  job_post_id?: string;
  // The LinkedIn post's author name, when the scraper could attribute this contact to one specific
  // post and that post exposed an author — see extraction.service.js's authorName / {{name}} template
  // variable. Left undefined rather than guessed when unknown (manual entries always lack this).
  author_name?: string;
  // The scraped post's raw text snippet (bounded, best-effort — see docs/memory.md's "Job matching"
  // section). Already saved to the DB and used server-side for AI email/match prompts; only added to this
  // type + storage.ts's mapping now, for JAMS's per-job detail view (JamsTab.tsx).
  context_text?: string;
  // JAMS match score (2026-08-18) — 0-100, set once per job post by the scraper worker when AI is
  // configured and the matched role has real criteria; null/undefined means "not yet analyzed" or "role
  // has no criteria set", never a fake 0. See ai.service.js's scoreJobMatch.
  match_score?: number | null;
  match_reasoning?: string | null;
  match_analyzed_at?: string | null;
  scraped_at?: string;
  // Reply monitoring (2026-08-19) — set by the backend's IMAP poller (replyPoll.worker.js) when an
  // inbound message is matched back to something sent to this contact. Never set client-side.
  hasReplied?: boolean;
  repliedAt?: string;
  replyCount?: number;
  // Automated follow-ups (2026-08-31) — set by the backend's followUp.worker.js (and on the initial send by
  // automail.worker.js/batchSend.worker.js/storage.ts's addSentLog). lastSentAt is the most recent send
  // (initial or follow-up) to this contact; followUpCount caps at 3 — see docs/architecture.md.
  lastSentAt?: string;
  followUpCount?: number;
};

export type Attachment = {
  id: string;
  name: string;
  type: string;
  url: string;
  storagePath: string;
  size?: number;
  // Set when this attachment was generated from a saved Resume Builder profile (2026-08-19, see
  // lib/resumePdf.tsx's useResumeProfilePdf) rather than uploaded directly — names which ResumeProfile it
  // came from, so a "🔄 Regenerate" action knows what to re-render from. Undefined for a plain upload. A
  // snapshot, not a live reference — editing the source resume later doesn't update this file on its own.
  sourceResumeProfileId?: string;
  // Set when this attachment was composed straight from a role's own profile-module selection (2026-08-20
  // — see lib/resumeCompose.ts's composeResumeData and ResumeConfigTab.tsx's handleBuildResumeFromProfile)
  // rather than from a saved ResumeProfile or a plain upload — names which RoleDef.id it came from, so a
  // "🔄 Refresh from profile" action knows to recompose from that role's current selection. Mutually
  // exclusive with sourceResumeProfileId in practice (one attachment has at most one source). Same
  // snapshot-not-live-reference tolerance — editing the profile/role later doesn't update this file until
  // refreshed explicitly.
  sourceRoleId?: string;
};

// One entry in a role's email-template library (2026-08-18: was a single row per role, then a
// randomized/default pool; 2026-08-19: randomization removed — see RoleDef.emailSendMode, which decides
// HOW a role's templates get used (manual pick, "let AI choose" among your own templates, or "let AI
// write it" — no template needed for that last one; set on the Email Templates tab's Configuration
// sub-tab). Attachments (resume + files) moved off templates entirely and onto the ROLE
// (CandidateProfile.files + RoleDef.selectedFileIds, same "select a subset of the profile's items"
// pattern as experience/education/etc.) — see docs/architecture.md's "Email Templates redesign" section.
// isDefault/inRandomizer/files are left in the shape (mapped from now-unused DB columns) but no longer
// read by anything — RoleDef.selectedTemplateId is the new "which one" in manual mode.
export type RoleTemplate = {
  id: string;
  label: string;
  subject: string;
  content: string;
  files: Attachment[];
  isDefault: boolean;
  inRandomizer: boolean;
};

// Retired 2026-08-19 (see docs/architecture.md's "Email Templates redesign" section) — resume choice
// moved onto each RoleTemplate (and one global default on CandidateProfile) instead of a separate
// role-scoped, randomized library. The automailsend_resumes table and this type are left in place, unused
// — same "superseded, never dropped" precedent as every other retired column/table in this project.
export type ResumeEntry = {
  id: string;
  role: string;
  label: string;
  files: Attachment[];
  isDefault: boolean;
  inRandomizer: boolean;
};

// Resume Builder (2026-08-18) — structured, section-by-section resume data with a live preview, distinct
// from ResumeEntry above (uploaded resume FILES for outreach attachments). A built resume can be exported
// and saved as a ResumeEntry too, but the two serve different things: editable structured data vs. a
// finished file. See docs/architecture.md.
// `description` (2026-08-19, replaces the old `bullets: string[]`) is one free-form block of text using
// a small markdown-lite syntax — a line starting with "- " or "* " is a bullet point, "**text**" is bold
// — instead of managing bullets as separate single-line inputs. See lib/markdownLite.tsx's
// renderMarkdownLite (rendering) and ResumeBuilder.tsx's MarkdownLiteField (editing).
export type ResumeExperience = {
  id: string;
  company: string;
  title: string;
  location: string;
  startDate: string;
  endDate: string;
  current: boolean;
  description: string;
};

// `notes` gets the same markdown-lite treatment as ResumeExperience.description (2026-08-19).
export type ResumeEducation = {
  id: string;
  school: string;
  degree: string;
  field: string;
  startDate: string;
  endDate: string;
  notes: string;
};

// `description` absorbed the old separate `bullets: string[]` (2026-08-19) — one markdown-lite block
// instead of a single-line description plus a separate bullet-by-bullet list.
export type ResumeProject = {
  id: string;
  name: string;
  description: string;
  link: string;
};

export type ResumeCertification = {
  id: string;
  name: string;
  issuer: string;
  date: string;
};

export type ResumeLanguage = {
  id: string;
  name: string;
  level: string;
};

// Typography controls (2026-08-20, operator ask — "I should be able to control the text size and the
// font... the padding of the page, the distance between the lines, the distance between the characters").
// Lives on ResumeData itself (like `summary`/`skills`) so it threads through profileDraft/scratchDraft/
// ResumeProfile.data and into PDF generation for free — no new persistence plumbing, no new prop
// threading anywhere. `style` is optional on ResumeData so already-persisted rows from before this field
// existed don't break; every reader falls back to `defaultResumeStyle()`. See
// lib/resumeTemplates/ModernTemplate.tsx/ClassicTemplate.tsx for how these apply, and
// ResumeBuilder.tsx's StyleSection for the editing UI.
export type ResumeStyleSettings = {
  fontFamily: string; // a full CSS font-family stack, one of RESUME_FONT_OPTIONS' values
  fontSizePt: number; // base body font size in pt — every other size in the templates scales with it
  lineHeight: number; // unitless line-height multiplier
  letterSpacingEm: number; // body text tracking, in em — headings compose with this, not override it
  pagePaddingMm: number; // page margin (all four sides), in mm
};

export function defaultResumeStyle(): ResumeStyleSettings {
  return { fontFamily: RESUME_FONT_OPTIONS[0].value, fontSizePt: 10.5, lineHeight: 1.45, letterSpacingEm: 0, pagePaddingMm: 15 };
}

// A short, curated list — deliberately all safe system-installed fonts (not the app's own webfonts), same
// reasoning the templates already documented: print/PDF output must never depend on a font-load race.
export const RESUME_FONT_OPTIONS: { label: string; value: string }[] = [
  { label: "Helvetica", value: "'Helvetica Neue', Arial, sans-serif" },
  { label: "Georgia", value: "Georgia, 'Times New Roman', serif" },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Times New Roman", value: "'Times New Roman', Times, serif" },
  { label: "Calibri", value: "Calibri, 'Segoe UI', Arial, sans-serif" },
  { label: "Courier New", value: "'Courier New', Courier, monospace" },
];

export type ResumeData = {
  personalInfo: {
    fullName: string;
    title: string;
    email: string;
    phone: string;
    location: string;
    portfolioUrl: string;
    linkedinUrl: string;
  };
  summary: string;
  experience: ResumeExperience[];
  education: ResumeEducation[];
  skills: string[];
  projects: ResumeProject[];
  certifications: ResumeCertification[];
  languages: ResumeLanguage[];
  style?: ResumeStyleSettings;
};

export const RESUME_TEMPLATE_IDS = ["modern", "classic"] as const;
export type ResumeTemplateId = typeof RESUME_TEMPLATE_IDS[number];

export function emptyResumeData(): ResumeData {
  return {
    personalInfo: { fullName: "", title: "", email: "", phone: "", location: "", portfolioUrl: "", linkedinUrl: "" },
    summary: "",
    experience: [],
    education: [],
    skills: [],
    projects: [],
    certifications: [],
    languages: [],
    style: defaultResumeStyle(),
  };
}

// A user can keep several of these (different versions/roles) — each independent once created.
export type ResumeProfile = {
  id: string;
  label: string;
  templateId: ResumeTemplateId;
  data: ResumeData;
};

export type SmtpConfig = {
  email: string; // The username for SMTP authentication
  appPassword: string;
  fromEmail?: string; // The sender email address
  fromName?: string;
  provider?: string;
  host?: string;
  port?: number;
  configured: boolean;
  batchMode?: "ai" | "template";
  batchTargetIds?: string[];
};

// One SMTP mailbox out of the user's pool (replaces the old single SmtpConfig as the source of truth for
// sending — SmtpConfig above is kept only as the shape of the "add/edit one account" form).
export type SmtpAccount = {
  id: string;
  label: string;
  provider: string;
  email: string;
  appPassword: string;
  host: string;
  port: number;
  fromEmail: string;
  fromName: string;
  dailyLimit: number;
  isVerified: boolean;
  isActive: boolean;
  // Reply monitoring (2026-08-19) — opt-in per account, since it means the backend connects to this
  // mailbox's real inbox via IMAP (not just sends through it). Reuses this same account's appPassword —
  // Gmail/Outlook app passwords work for both SMTP and IMAP, so no separate secret to collect.
  imapEnabled: boolean;
  imapHost?: string;
  imapPort?: number;
};

export type SendResult = {
  email: string;
  role: Role;
  success: boolean;
  error?: string;
  skipped?: boolean;
};

export type SentRecord = {
  email: string;
  role: Role;
  title: string;
  subject?: string;
  body?: string;
  status: "sent" | "failed" | "skipped";
  error?: string;
  sentAt: string;
  // Which template/resume library entry was actually used for this send (2026-08-18) — a label
  // snapshot, not a live reference, since the library row can be renamed/edited/deleted later and the
  // log should keep reflecting what was true at send time. Undefined for older rows sent before this
  // existed, or when no resume was attached. templateLabel is "Custom" for a Quick Send hand-written
  // draft (no library template involved at all).
  templateLabel?: string;
  resumeLabel?: string;
  // Automated follow-ups (2026-08-31) — undefined when the role has no follow_up_interval_days set (follow-
  // ups off); addSentLog uses this to schedule the recipient's next_follow_up_at alongside logging the send.
  nextFollowUpAt?: string | null;
};

// An inbound reply the backend's IMAP poller matched back to a previously-sent email (2026-08-19) —
// see docs/architecture.md's "Reply monitoring" section. Read-only from the frontend; only
// replyPoll.worker.js ever writes automailsend_replies. `matchMethod` is surfaced for transparency
// rather than presenting every match as equally certain.
export type ReplyRecord = {
  id: string;
  recipientId?: string;
  fromEmail: string;
  subject?: string;
  bodySnippet?: string;
  receivedAt?: string;
  matchMethod?: "header" | "sender_subject";
};

// Keywords moved to per-role (RoleDef.keywords) — this is now pure scraper mechanics.
export type AutoFetchConfig = {
  enabled: boolean;
  intervalMin: number;
  paginationLimit: number;
  paginationDelaySec: number;
  liAt: string;
  jsessionid: string;
  rawHeaders: string;
  postAgeFilter: "any" | "past-24h" | "past-week" | "past-month";
};

// Shared "is LinkedIn actually connected" check (2026-08-25) — both cookies present, not just one. Used by
// JamsOverviewTab.tsx's read-only status and SettingsTab.tsx's Connections row so the two can't drift.
export function autoFetchLinkedInConnected(config: AutoFetchConfig): boolean {
  return !!(config.liAt && config.liAt.trim() && config.jsessionid && config.jsessionid.trim());
}

export type AutomailConfig = {
  enabled: boolean;
  dailyLimit: number;
  candidateInfo: string;
};

// The AI tab (2026-08-18) — AI now has its own real settings page, so its config moved out of
// AutomailConfig instead of being nested under "Automail" naming. `credits` stays a separate top-level
// field on PersistedState (admin-controlled, never written from here — see saveAppState).
// `matchStrictness` (0-100) gates two things, never JAMS's manual/bulk sends: automail.worker.js's
// fully-automated background loop (skips a low-scoring pending recipient before sending), and, since
// 2026-08-28, scraper.worker.js itself (a post scored below this at scrape time is never saved as a
// recipient at all — see scraper.worker.js's saveContacts). A recipient/post with no match_score yet
// is never gated by either.
export type AiConfig = {
  enabled: boolean;
  temperature: number; // 0-1, Gemini generationConfig.temperature for every AI call
  matchStrictness: number;
};

// A skill needs a stable id (2026-08-19) once a role can select a *subset* of a shared list — plain
// strings (ResumeData.skills' shape) are fine when a resume owns its own full copy, not fine here.
export type ProfileSkill = { id: string; name: string };

// The permanent knowledge base (2026-08-19 — was a 5-field contact card, now the candidate's whole
// professional history: identity, bio, and every experience/education/project/certification/skill
// they've ever had). Built once, kept up to date, and reused across every role — a role only ever
// references a subset of these by id (RoleDef.selected*Ids), it never forks or copies them. Backs the
// {{candidate_*}} template variables (see ai.service.js's applyPlaceholders) and is the sole input to
// lib/resumeCompose.ts's composeResumeData. All fields optional/blank-safe — nothing here is guessed,
// only ever what the user entered on the Profile page. Separate from AutomailConfig.candidateInfo (a
// free-text blurb feeding the AI-personalization prompt — left as its own thing, not merged in here).
export type CandidateProfile = {
  name: string;
  email: string;
  phone: string;
  address: string;
  bio: string;
  portfolioUrl: string;
  resumeUrl: string;
  education: ResumeEducation[];
  experience: ResumeExperience[];
  projects: ResumeProject[];
  certifications: ResumeCertification[];
  skills: ProfileSkill[];
  languages: ResumeLanguage[];
  // The candidate's whole pool of resume/portfolio/attachment files (2026-08-19) — one permanent, shared
  // collection everything else references by id, never duplicated. A resume can either be uploaded
  // directly here, or generated from a saved Resume Builder profile (see Attachment.sourceResumeProfileId)
  // — treated as just another file, not a separate special-cased slot. See docs/architecture.md's "Email
  // Templates redesign" section.
  files: Attachment[];
  // The hierarchy's top (2026-08-20) — which pool entry is the default resume every role inherits unless
  // it sets its own RoleDef.resumeId override. null = none set yet. Replaces an earlier design where a
  // role could select any number of resume-shaped files with no distinction from a portfolio file — see
  // docs/architecture.md's "Email Templates redesign" section's newest follow-up.
  globalResumeId: string | null;
};

export function emptyCandidateProfile(): CandidateProfile {
  return {
    name: "",
    email: "",
    phone: "",
    address: "",
    bio: "",
    portfolioUrl: "",
    resumeUrl: "",
    education: [],
    experience: [],
    projects: [],
    certifications: [],
    skills: [],
    languages: [],
    files: [],
    globalResumeId: null,
  };
}

// Recruiter portal + AI-assisted ATS (2026-08-19). Account type (candidate vs. recruiter) is chosen once
// at signup and locked for good (see signup/page.tsx) — RecruiterProfile's existence is still what
// unlocks the Recruiter tab (same pattern as every other capability flag in this app), it's just no
// longer something a candidate account can self-serve activate later. Fully separate AI settings
// (ats_ai_enabled/ats_ai_credits) from candidate-side AiConfig — different feature, shouldn't share one
// balance. See docs/architecture.md's "Recruiter portal" section.
export type RecruiterProfile = {
  userId: string;
  companyName: string;
  atsAiEnabled: boolean;
  atsAiCredits: number;
};

export type JobPostingStatus = "open" | "closed";

export type JobPosting = {
  id: string;
  recruiterId: string;
  title: string;
  company: string;
  description: string;
  location: string;
  workMode: WorkMode;
  employmentType: EmploymentType;
  salaryCurrency: string;
  salaryPeriod: SalaryPeriod;
  salaryMin: number | null;
  salaryMax: number | null;
  status: JobPostingStatus;
  createdAt: string;
};

export type JobApplicationStatus = "submitted" | "shortlisted" | "rejected";

// A candidate's resume is captured as a SNAPSHOT at apply time — resumeData (from the Resume Builder) or
// a resumeFileUrl/resumeFileName (from the resume file library), same "snapshot, not a live reference"
// reasoning as SentRecord's templateLabel/resumeLabel. AI-ATS scoring only ever runs against resumeData
// (structured, already proven for AI prompts) — an application with only a file resume stays unscored
// (aiAnalyzedAt null), same "unknown isn't a fail" precedent as Recipient.match_score.
export type JobApplication = {
  id: string;
  jobId: string;
  candidateId: string;
  candidateName: string;
  candidateEmail: string;
  candidatePhone: string;
  coverNote: string;
  resumeData: ResumeData | null;
  resumeFileUrl?: string;
  resumeFileName?: string;
  status: JobApplicationStatus;
  aiScore: number | null;
  aiReasoning: string | null;
  aiAnalyzedAt: string | null;
  createdAt: string;
};

// Replaces the old `ROLE_LABELS[role]` fixed lookup — finds the display label for a role key in the
// user's own role defs, falling back to the raw key so an unrecognized/stale role never renders blank.
export function roleLabel(roleDefs: RoleDef[], key: string): string {
  return roleDefs.find((d) => d.key === key)?.label ?? key;
}
