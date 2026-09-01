// Server-only. Ports backend/src/services/ai.service.js's callAiJson (Gemini, JSON-mode, 429 retry/
// backoff) — deliberately duplicated across the two deployables, same reasoning as crypto.ts/crypto.js.
// KEEP IN SYNC with the backend copy.
//
// Only ever import this from a Next.js API route (runtime = "nodejs"), never from a "use client"
// component — it uses the platform's own Gemini key (GEMINI_API_KEY) and the Supabase service role key,
// neither of which may ever reach the browser bundle.
//
// Platform-managed AI (2026-08-18): this used to take a per-user provider/apiKey and dispatch across
// OpenAI/Groq/Gemini. Collapsed to Gemini-only (the platform's own enterprise key, never the user's) now
// that every AI feature draws from an admin-granted credit balance instead of BYOK — see
// docs/architecture.md. spendAiCredit()/getAuthedUserId() below are the credit-metering + auth-check
// plumbing shared by /api/ai-enhance and /api/resume-import.
import { createClient } from "@supabase/supabase-js";
import { emptyResumeData, type CandidateProfile, type JobPosting, type ResumeData } from "./types";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Truncate a candidate-controlled free-text field before it reaches a prompt — mirrors ai.service.js's
// same-named helper (KEEP IN SYNC). Defense against one huge paste inflating a call's cost/latency,
// independent of whatever the UI's own maxLength enforces. 2026-08-25, operator ask.
function truncateForPrompt(text: string, maxLen: number): string {
  return text.length > maxLen ? `${text.slice(0, maxLen)}\n[...truncated]` : text;
}

// See ai.service.js (KEEP IN SYNC) — "gemini-1.5-flash" was retired from the API (confirmed 404 against
// the live key, 2026-08-25); using the "-latest" alias on purpose so this doesn't silently go stale again.
const GEMINI_MODEL = "gemini-flash-latest";

// Cost metering (2026-08-29, Phase 3) — logs one row per Gemini call to automailsend_ai_usage_log: real
// token counts (from Gemini's own usageMetadata, previously discarded entirely here) plus a $ cost computed
// at insert time from the rate in effect then, so historical rows stay accurate after a future rate change.
// KEEP IN SYNC with backend/src/lib/aiUsage.js's twin — same rates, same table, same call_type labels.
// Inlined here rather than a separate lib file — this file already keeps spendAiCredit/checkAiGate/
// spendAtsAiCredit inline rather than split out, unlike the backend's aiCredits.js/ai.service.js split.
function getGeminiRates() {
  const stepAt = Date.UTC(2027, 0, 1); // Google's published rate card steps up on this date
  if (Date.now() < stepAt) {
    return { inputPerMillion: 0.75, outputPerMillion: 3.75, tier: "introductory (through 2026-12-31)" };
  }
  return { inputPerMillion: 1.5, outputPerMillion: 7.5, tier: "standard (from 2027-01-01)" };
}

type GeminiUsageMetadata = { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };

// Never throws into callAiJson's own error handling — see the try/catch around its call site below. Its
// own contract is simpler: "write the row or throw."
async function logAiUsage(userId: string | undefined, callType: string, usageMetadata: GeminiUsageMetadata | undefined) {
  const promptTokens = usageMetadata?.promptTokenCount || 0;
  const completionTokens = usageMetadata?.candidatesTokenCount || 0;
  const totalTokens = usageMetadata?.totalTokenCount || promptTokens + completionTokens;
  const rates = getGeminiRates();
  const costUsd = (promptTokens / 1_000_000) * rates.inputPerMillion + (completionTokens / 1_000_000) * rates.outputPerMillion;

  const { error } = await getSupabaseAdmin().from("automailsend_ai_usage_log").insert({
    user_id: userId || null,
    call_type: callType,
    model: GEMINI_MODEL,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    cost_usd: costUsd,
    pricing_snapshot: rates,
  });
  if (error) throw new Error(error.message);
}

// Rate limiting (2026-08-25, operator ask) — mirrors ai.service.js's MIN_GEMINI_INTERVAL_MS (KEEP IN
// SYNC), but weaker here by nature: each request is its own serverless invocation, so this module-level
// state only helps when Vercel happens to reuse a warm instance for back-to-back calls — not a guarantee.
// The real target for this throttle is the backend's tight per-recipient/per-post loops (automail.worker.js
// etc.); this route is always one human-triggered call at a time (Quick Send's "Generate", one resume
// import), a much lower burst risk, so best-effort here plus the 429 backoff below is enough.
const MIN_GEMINI_INTERVAL_MS = process.env.GEMINI_MIN_INTERVAL_MS ? parseInt(process.env.GEMINI_MIN_INTERVAL_MS, 10) : 4200;
let lastGeminiCallAt = 0;
async function throttleGeminiCall() {
  const wait = lastGeminiCallAt + MIN_GEMINI_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastGeminiCallAt = Date.now();
}

// `temperature` (2026-08-18, the AI tab) — 0-1, user-configurable, defaults to 0.4 when not passed.
// `userId`/`callType` (2026-08-29, cost metering) — optional, purely for usage logging; every real caller
// below passes both. Logging never affects what this function returns or throws — see the try/catch below.
async function callAiJson(systemPrompt: string, userPrompt: string, temperature?: number, userId?: string, callType?: string): Promise<any> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured on the server.");

  let delay = 2000;
  const retries = 3;

  for (let attempt = 1; attempt <= retries; attempt++) {
    await throttleGeminiCall();
    const baseUrl = process.env.GEMINI_API_URL || `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    // 20s timeout (2026-08-25) — an AbortController since fetch has no built-in one; a hung upstream call
    // would otherwise ride out the whole Vercel function duration instead of failing cleanly.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let res: Response;
    try {
      res = await fetch(`${baseUrl}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: { responseMimeType: "application/json", temperature: typeof temperature === "number" ? temperature : 0.4 },
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 && attempt < retries) { await sleep(delay); delay *= 2; continue; }
    if (!res.ok) throw new Error(`AI request failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    // Log right after the response arrives, before JSON.parse — tokens were spent whether or not the
    // model's own output happens to parse cleanly. Awaited (not fire-and-forget — this runs inside a
    // serverless function that can suspend right after the response is sent, which would silently drop an
    // un-awaited write), but never allowed to fail the actual AI call.
    try {
      await logAiUsage(userId, callType || "unknown", data.usageMetadata);
    } catch (logErr) {
      console.error(`[aiClient] AI usage logging failed (call itself succeeded): ${(logErr as Error).message}`);
    }
    return JSON.parse(data.candidates[0].content.parts[0].text);
  }
  throw new Error("AI request failed after retries.");
}

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return createClient(url, key);
}

// Resolves the real, authenticated caller from a Bearer session token — same pattern as
// /api/admin/users/route.ts's verifyAdmin, minus the admin-email check. Neither AI route trusted a
// client-supplied userId before this (they never touched the DB), so this is new: once a route spends a
// credit against a user, that user must be who the token actually says, not a client-supplied field.
export async function getAuthedUserId(req: Request): Promise<string | null> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const token = authHeader.replace("Bearer ", "");
  const { data: { user }, error } = await getSupabaseAdmin().auth.getUser(token);
  if (error || !user) return null;
  return user.id;
}

export type AiGateResult = { ok: true; temperature: number } | { ok: false; error: string };

// Checked before attempting a Gemini call — cheap enough to always do fresh rather than trust a
// possibly-stale client-side credit count. Also returns the user's AI-tab temperature setting so callers
// don't need a second query just to get it.
export async function checkAiGate(userId: string): Promise<AiGateResult> {
  const { data } = await getSupabaseAdmin()
    .from("automailsend_app_state")
    .select("ai_personalization_enabled, ai_credits, ai_temperature")
    .eq("user_id", userId)
    .single();
  if (!data?.ai_personalization_enabled) return { ok: false, error: "AI personalization isn't enabled for this account." };
  if (!data.ai_credits || data.ai_credits <= 0) return { ok: false, error: "Out of AI credits — ask an admin to grant more." };
  return { ok: true, temperature: typeof data.ai_temperature === "number" ? data.ai_temperature : 0.4 };
}

// Spend ONE credit — call this only after a Gemini response actually succeeded, never before (a
// network/API failure shouldn't cost a credit). Optimistic-locking conditional update, same reasoning as
// the backend twin (backend/src/lib/aiCredits.js) — good enough for admin-granted internal credits.
export async function spendAiCredit(userId: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase.from("automailsend_app_state").select("ai_credits").eq("user_id", userId).single();
  const current = row?.ai_credits ?? 0;
  if (current <= 0) return false;
  const { data: updated } = await supabase
    .from("automailsend_app_state")
    .update({ ai_credits: current - 1 })
    .eq("user_id", userId)
    .eq("ai_credits", current)
    .select("ai_credits");
  return Array.isArray(updated) && updated.length > 0;
}

// Not the scraped-job-post prompt (JOB_APPLICATION_SYSTEM_PROMPT in ai.service.js) — Quick Send has no
// job post to read, just a manually-drafted (possibly blank) subject/body to polish or write from scratch.
const QUICK_SEND_ENHANCE_SYSTEM_PROMPT = `You help a job candidate polish a short outreach email to an HR contact/recruiter before they send it. Your only output is a single JSON object — no markdown, no commentary.

You will be given:
- CURRENT DRAFT SUBJECT / CURRENT DRAFT BODY — what the candidate has typed so far. Either may be empty, in which case write one from scratch using CANDIDATE INFO.
- CANDIDATE INFO — background/skills/what they're looking for. May be empty.
- CANDIDATE CONTACT INFO — only the contact channels the candidate actually filled in (name/email/phone/portfolio/resume link). A channel not listed here was not provided — never invent one.
- RECIPIENT NAME — the HR contact/recruiter's own name, for the greeting ("Hi <name>,"). Not a job title.
- JOB TITLE / POSITION — the specific role being applied for, if given. Not a person's name.
- CANDIDATE'S TARGET ROLE CATEGORY — the broad role bucket the candidate searches under (e.g. "Backend
  Developer"); use JOB TITLE instead whenever it's given, since it's more specific.

RECIPIENT NAME and JOB TITLE are two different things even when only one is known — never substitute one
for the other, and never greet the recipient by a job title or refer to a person's name as if it were the
position.

Rules:
1. If a draft is already provided, preserve its intent and any concrete facts it states — polish tone, clarity, and persuasiveness, don't rewrite it into something unrecognizable.
2. Never invent experience, credentials, or facts not present in CANDIDATE INFO.
3. Never output a literal placeholder like [Name], [Company], or {{title}} — every value you were given is either real (use it) or not given (omit gracefully, don't guess).
4. Sign off with the candidate's real name if given; include only the contact channels CANDIDATE CONTACT INFO actually lists.
5. Keep it concise — a few short paragraphs, not a cover letter.

Output ONLY this JSON shape: {"subject": "<email subject>", "body": "<the email body, plain text>"}`;

function buildCandidateContactBlock(profile?: Partial<CandidateProfile>): string {
  const p = profile || {};
  const lines: string[] = [];
  if (p.name?.trim()) lines.push(`Name: ${p.name.trim()}`);
  if (p.email?.trim()) lines.push(`Email: ${p.email.trim()}`);
  if (p.phone?.trim()) lines.push(`Phone: ${p.phone.trim()}`);
  if (p.portfolioUrl?.trim()) lines.push(`Portfolio: ${p.portfolioUrl.trim()}`);
  if (p.resumeUrl?.trim()) lines.push(`Resume: ${p.resumeUrl.trim()}`);
  return lines.length > 0 ? lines.join("\n") : "Not provided.";
}

export type EnhanceQuickSendInput = {
  draftSubject: string;
  draftBody: string;
  candidateInfo?: string;
  profile?: Partial<CandidateProfile>;
  recipientName?: string;
  recipientRole?: string;
  recipientJobTitle?: string;
  temperature?: number;
  userId?: string;
};

export async function enhanceQuickSendEmail(input: EnhanceQuickSendInput): Promise<{ subject: string; body: string }> {
  const prompt = `CURRENT DRAFT SUBJECT:
${input.draftSubject?.trim() || "(empty)"}

CURRENT DRAFT BODY:
${input.draftBody?.trim() || "(empty)"}

CANDIDATE INFO:
${input.candidateInfo?.trim() ? truncateForPrompt(input.candidateInfo.trim(), 4000) : "No candidate info provided — write generically but do not invent specifics."}

CANDIDATE CONTACT INFO:
${buildCandidateContactBlock(input.profile)}

RECIPIENT NAME (a person, for the greeting):
${input.recipientName?.trim() || "unknown"}

JOB TITLE / POSITION (what's being applied for, not a person):
${input.recipientJobTitle?.trim() || "unknown"}

CANDIDATE'S TARGET ROLE CATEGORY:
${input.recipientRole?.trim() || "unknown"}`;

  const result = await callAiJson(QUICK_SEND_ENHANCE_SYSTEM_PROMPT, prompt, input.temperature, input.userId, "quick_send_enhance");
  if (!result || typeof result.subject !== "string" || typeof result.body !== "string") {
    throw new Error("AI response was not in the expected format.");
  }
  return { subject: result.subject, body: result.body };
}

// Resume Builder import (2026-08-18) — the one AI-powered path in the Resume Builder (everything else is
// plain client-side form-to-preview binding, no AI). Takes raw text already extracted from an uploaded
// PDF (see app/api/resume-import/route.ts's use of pdf-parse) and structures it into ResumeData for the
// user to review before saving — never invents content that isn't actually in the source text.
const RESUME_IMPORT_SYSTEM_PROMPT = `You extract structured resume data from raw text pulled from a candidate's existing resume PDF. Your only output is a single JSON object — no markdown, no commentary.

Extract only what the text actually states. Never invent an employer, dates, a degree, or a skill that isn't there. Leave a field as an empty string, or an array empty, rather than guessing. Dates: keep whatever format the source uses (e.g. "Jan 2022", "2022", "2022-01") — don't reformat or invent missing ones. For current/ongoing roles the source often says "Present" — set "current": true and leave endDate empty in that case.

"description" fields (experience, projects) and "notes" (education) hold free text, not a bullet array. If the source resume lists bullet-point achievements under a role/project, put each one on its own line starting with "- " within that single description string (e.g. "- Led a team of 5 engineers\\n- Cut deploy time by 40%"). If it's prose instead, just carry the prose over as-is.

Output ONLY this exact JSON shape:
{
  "personalInfo": { "fullName": "", "title": "", "email": "", "phone": "", "location": "", "portfolioUrl": "", "linkedinUrl": "" },
  "summary": "",
  "experience": [ { "company": "", "title": "", "location": "", "startDate": "", "endDate": "", "current": false, "description": "" } ],
  "education": [ { "school": "", "degree": "", "field": "", "startDate": "", "endDate": "", "notes": "" } ],
  "skills": [""],
  "projects": [ { "name": "", "description": "", "link": "" } ],
  "certifications": [ { "name": "", "issuer": "", "date": "" } ],
  "languages": [ { "name": "", "level": "" } ]
}`;

export async function parseResumeText(resumeText: string, temperature?: number, userId?: string): Promise<ResumeData> {
  const result = await callAiJson(RESUME_IMPORT_SYSTEM_PROMPT, `RESUME TEXT:\n${resumeText.slice(0, 15000)}`, temperature, userId, "resume_import");
  const base = emptyResumeData();
  if (!result || typeof result !== "object") return base;

  // Merge defensively — the model's JSON-mode output is usually well-formed, but any field here that
  // doesn't match the expected shape falls back to empty rather than crashing the import.
  const withIds = <T extends Record<string, unknown>>(items: unknown): (T & { id: string })[] =>
    Array.isArray(items) ? items.map((it) => ({ ...(it as T), id: crypto.randomUUID() })) : [];

  return {
    personalInfo: { ...base.personalInfo, ...(result.personalInfo || {}) },
    summary: typeof result.summary === "string" ? result.summary : "",
    experience: withIds(result.experience),
    education: withIds(result.education),
    skills: Array.isArray(result.skills) ? result.skills.filter((s: unknown) => typeof s === "string") : [],
    projects: withIds(result.projects),
    certifications: withIds(result.certifications),
    languages: withIds(result.languages),
  };
}

// Job-post summary (2026-09-02) — backs the Emails detail panel's "The job" section. Replaces a plain-code
// truncation of the raw scraped post (which still read as raw scraped text, not a real summary) with an
// actual AI-written one. Generated on-demand (see app/api/summarize-post/route.ts), not at scrape time —
// the backend's match-scoring pipeline deliberately runs a free algorithm first and only calls Gemini when
// it can't resolve confidently, so there's no reliable per-post AI call already happening to piggyback
// this onto; summarizing every scraped post regardless of whether anyone looks at it would be a new,
// unconditional cost working against that same cost-minimization design.
const JOB_POST_SUMMARY_SYSTEM_PROMPT = `You write a short, plain-language summary of a job posting for a job candidate. Your only output is a single JSON object — no markdown, no commentary.

You will be given the raw scraped text of a job post (it may include line-break artifacts, irrelevant boilerplate, or be cut off mid-sentence). Summarize only what the job post actually is — the role, what the company is looking for, and any standout requirement or benefit it clearly states. 2-3 sentences.

Never invent a detail not present in the text. Never mention that this text was "scraped," "posted on LinkedIn," or came from an AI — write it as a plain, direct description of the job.

Output ONLY this JSON shape: {"summary": "<2-3 sentence summary>"}`;

export async function summarizeJobPost(contextText: string, temperature?: number, userId?: string): Promise<string> {
  const prompt = `JOB POST TEXT:\n${truncateForPrompt(contextText.trim(), 6000)}`;
  const result = await callAiJson(JOB_POST_SUMMARY_SYSTEM_PROMPT, prompt, temperature, userId, "summarize_job_post");
  if (!result || typeof result.summary !== "string" || !result.summary.trim()) {
    throw new Error("AI response was not in the expected format.");
  }
  return result.summary.trim();
}

// --- Recruiter portal + AI-assisted ATS (2026-08-19) — see docs/architecture.md ---
//
// Own gate/credit pair against automailsend_recruiter_profiles rather than reusing checkAiGate/
// spendAiCredit above — AI-ATS is a different feature from candidate-side AI personalization and
// shouldn't share one balance, even for a user who happens to be both a candidate and a recruiter.

export type AtsAiGateResult = { ok: true } | { ok: false; error: string };

export async function checkAtsAiGate(recruiterId: string): Promise<AtsAiGateResult> {
  const { data } = await getSupabaseAdmin()
    .from("automailsend_recruiter_profiles")
    .select("ats_ai_enabled, ats_ai_credits")
    .eq("user_id", recruiterId)
    .maybeSingle();
  if (!data?.ats_ai_enabled) return { ok: false, error: "AI-ATS isn't enabled for this recruiter account." };
  if (!data.ats_ai_credits || data.ats_ai_credits <= 0) return { ok: false, error: "Out of AI-ATS credits — ask an admin to grant more." };
  return { ok: true };
}

export async function spendAtsAiCredit(recruiterId: string): Promise<boolean> {
  const supabase = getSupabaseAdmin();
  const { data: row } = await supabase.from("automailsend_recruiter_profiles").select("ats_ai_credits").eq("user_id", recruiterId).single();
  const current = row?.ats_ai_credits ?? 0;
  if (current <= 0) return false;
  const { data: updated } = await supabase
    .from("automailsend_recruiter_profiles")
    .update({ ats_ai_credits: current - 1 })
    .eq("user_id", recruiterId)
    .eq("ats_ai_credits", current)
    .select("ats_ai_credits");
  return Array.isArray(updated) && updated.length > 0;
}

// Only ever scores structured resume data (from the Resume Builder) — a candidate who only attached a
// file resume stays unscored, same "unknown isn't a fail" precedent as JAMS's match_score. Reduces a
// ResumeData object to plain text since that's already the proven shape for feeding a Gemini prompt.
function serializeResumeForAts(resume: ResumeData): string {
  const lines: string[] = [];
  if (resume.summary?.trim()) lines.push(`SUMMARY: ${resume.summary.trim()}`);
  if (resume.skills?.length) lines.push(`SKILLS: ${resume.skills.join(", ")}`);
  if (resume.experience?.length) {
    lines.push("EXPERIENCE:");
    for (const e of resume.experience) {
      lines.push(`- ${e.title || "Unknown title"} at ${e.company || "Unknown company"} (${e.startDate || "?"} – ${e.current ? "Present" : e.endDate || "?"})`);
      // description is a markdown-lite block (2026-08-19) — plain text, Gemini reads "- " bullet lines
      // fine as-is, no parsing needed here.
      if (e.description?.trim()) lines.push(`  ${e.description.trim().split("\n").join("\n  ")}`);
    }
  }
  if (resume.education?.length) {
    lines.push("EDUCATION:");
    for (const ed of resume.education) lines.push(`- ${ed.degree || ""} ${ed.field ? `in ${ed.field}` : ""} — ${ed.school || "Unknown school"}`.trim());
  }
  if (resume.projects?.length) {
    lines.push("PROJECTS:");
    for (const p of resume.projects) lines.push(`- ${p.name || "Untitled"}: ${p.description || ""}`.trim());
  }
  return lines.length > 0 ? lines.join("\n") : "No resume content provided.";
}

const JOB_POSTING_MATCH_SYSTEM_PROMPT = `You judge how well a candidate's resume matches a job posting, for a recruiter's AI-assisted ATS. Your only output is a single JSON object — no markdown, no commentary.

You will be given:
- JOB POSTING — the recruiter's own title, description, and requirements for the role they posted.
- CANDIDATE RESUME — structured resume content the candidate submitted with their application.

Score how well CANDIDATE RESUME fits JOB POSTING on a 0-100 scale:
- Score high only when the resume's own content actually supports a match — relevant experience, skills, or education the posting asks for.
- Score low when the resume clearly lacks what the posting requires, or shows experience in an unrelated field.
- If the resume has too little content to judge, score low and say so rather than guessing generously.

Output ONLY this JSON shape: {"score": <integer 0-100>, "reasoning": "<one short sentence, under 200 characters, citing the specific thing(s) that drove the score>"}`;

export async function scoreApplicationMatch(
  resumeData: ResumeData,
  posting: Pick<JobPosting, "title" | "description" | "company">,
  temperature?: number,
  userId?: string
): Promise<{ score: number; reasoning: string } | null> {
  const prompt = `JOB POSTING:
Title: ${posting.title}
Company: ${posting.company || "Not specified"}
Description: ${posting.description}

CANDIDATE RESUME:
${serializeResumeForAts(resumeData)}`;

  const result = await callAiJson(JOB_POSTING_MATCH_SYSTEM_PROMPT, prompt, temperature, userId, "score_application_match");
  if (!result || typeof result.score !== "number" || Number.isNaN(result.score)) return null;
  const score = Math.max(0, Math.min(100, Math.round(result.score)));
  const reasoning = typeof result.reasoning === "string" ? result.reasoning.slice(0, 240).trim() : "";
  return { score, reasoning };
}
