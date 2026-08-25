const axios = require("axios");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Truncate free-text that a candidate controls directly (not the already-bounded scraped context_text,
// see extraction.service.js's substring(0, 5000)) before it reaches a prompt — defense against one huge
// paste inflating every future Gemini call's cost/latency for that user, independent of whatever the UI's
// own maxLength enforces (never trust a client-side limit alone). 2026-08-25, operator ask ("other
// API-related security stuff").
function truncateForPrompt(text, maxLen) {
  if (!text) return text;
  return text.length > maxLen ? `${text.slice(0, maxLen)}\n[...truncated]` : text;
}

// The one fixed, documented variable set (see docs/architecture.md's "Template variables" section) —
// exported so both workers import this instead of keeping their own copy (three duplicate copies of this
// exact function caused real drift once already, see docs/memory.md). Two kinds:
//  - job/recruiter-side ({{title}}, {{name}}): best-effort, scraped, blank rather than guessed when unknown.
//  - candidate-side ({{candidate_*}}): fully user-controlled via the Profile page — blank only if the user
//    genuinely hasn't filled that field in yet.
// `profile` is optional so existing callers/tests that don't pass one still work (candidate_* fields just
// come out blank).
function applyPlaceholders(text, recipient, profile) {
  const p = profile || {};
  return text
    .replaceAll("{{title}}", recipient.title || "")
    .replaceAll("{{name}}", recipient.author_name || "")
    .replaceAll("{{email}}", recipient.email)
    .replaceAll("{{candidate_name}}", p.name || "")
    .replaceAll("{{candidate_email}}", p.email || "")
    .replaceAll("{{candidate_phone}}", p.phone || "")
    .replaceAll("{{candidate_portfolio}}", p.portfolioUrl || "")
    .replaceAll("{{candidate_resume_link}}", p.resumeUrl || "");
}

// The hard guardrail: no email may ever be sent with a literal unresolved {{...}} token in it. Both
// workers call this right before actually sending, on the final subject+body — if it matches, the send is
// blocked (failed, not delivered) rather than shipping a broken email to a real person.
function hasUnresolvedPlaceholders(text) {
  return /\{\{\s*[\w.]+\s*\}\}/.test(text || "");
}

// Hardcoded, expert-written instructions for the AI. Not user-editable — the only thing the user
// supplies is CANDIDATE INFO (see buildUserMessage below); the job post and base template are
// injected automatically per recipient.
const JOB_APPLICATION_SYSTEM_PROMPT = `You are an expert job-application email writer. You write on behalf of a real candidate who is applying to a specific job opportunity found in a LinkedIn post written by a recruiter, hiring manager, or founder. Your only output is a single JSON object — no markdown, no commentary.

You will be given, in the user message:
- CANDIDATE INFO — the candidate's background, skills, experience, and what they're looking for.
- CANDIDATE CONTACT INFO — the candidate's own name/email/phone/portfolio/resume link, exactly as they entered it in their profile. Only the lines actually present are given — a line is omitted entirely (not shown as blank) when the candidate hasn't filled it in.
- CONTACT NAME — the actual name of the person who posted the opportunity, if it's known. This is real data, not a guess — use it confidently when present ("Hi <name>,"). If it says "unknown", do NOT invent a name or use a placeholder greeting like "Hi there" that sounds like it's covering for a missing one — open the email a different way instead (lead with the role/company, or a direct opening line).
- SEARCH KEYWORD — the job title/keyword that was searched to find this post. Treat it as a likely but unconfirmed job title; prefer whatever more specific title JOB POST itself states, if any.
- JOB POST — the raw scraped text of the LinkedIn post describing the opportunity. It may be noisy, partial, or (rarely) not actually a job post.
- BASE TEMPLATE — a subject/body the candidate normally sends. Treat its tone and structure as your starting point, but never copy a literal token like {{title}} or [Company] from it into your output — those are template placeholders for a different code path, not content. May say "None — write the email entirely in your own words" instead: the candidate has no template at all, so use your own judgment for tone and structure (professional, warm, concise) based only on CANDIDATE INFO and JOB POST.

Decide first: is JOB POST actually a job/hiring opportunity that's plausibly relevant to the candidate?
- If not (spam, an unrelated post, or too vague to tell), respond with exactly: {"skip": true, "reason": "<one short sentence>"}
- Otherwise, continue below.

Write the email:
1. Reference 1-2 concrete, specific details actually present in JOB POST (the role, tech stack, company name if given, a requirement mentioned) — enough that a human reader can tell you read their post, not a template.
2. Ground the pitch in CANDIDATE INFO — mention only real skills/experience it contains. Never invent experience, credentials, or facts about the candidate that aren't in CANDIDATE INFO.
3. Never output bracket or brace placeholders like [Name], [Company], {{title}} anywhere — every field you were given is either a real value to use or explicitly unknown to omit. There is no later step that fills these in.
4. Sign off with the candidate's real name if CANDIDATE INFO or CANDIDATE CONTACT INFO gives one; otherwise omit a name line entirely rather than using a generic one. In the sign-off, include only whichever of phone/portfolio/resume link CANDIDATE CONTACT INFO actually lists — never invent or imply one that wasn't given, and never list one you weren't given even if it seems like a natural thing to include.
5. When BASE TEMPLATE is given, keep its tone (formal/casual) unless JOB POST clearly calls for something else. When there is none, default to a professional, warm, concise tone.
6. Keep it concise — a few short paragraphs, not a cover letter wall of text.

Output ONLY this JSON shape: {"subject": "<email subject>", "body": "<the email body, plain text or simple HTML>"}`;

// Builds the "only the lines that are actually filled in" CANDIDATE CONTACT INFO block described in the
// system prompt above — omitting a field entirely (not showing it blank) when the candidate hasn't set it.
function buildCandidateContactBlock(profile) {
  const p = profile || {};
  const lines = [];
  if (p.name && p.name.trim()) lines.push(`Name: ${p.name.trim()}`);
  if (p.email && p.email.trim()) lines.push(`Email: ${p.email.trim()}`);
  if (p.phone && p.phone.trim()) lines.push(`Phone: ${p.phone.trim()}`);
  if (p.portfolioUrl && p.portfolioUrl.trim()) lines.push(`Portfolio: ${p.portfolioUrl.trim()}`);
  if (p.resumeUrl && p.resumeUrl.trim()) lines.push(`Resume: ${p.resumeUrl.trim()}`);
  return lines.length > 0 ? lines.join("\n") : "Not provided.";
}

// baseTemplate is optional (2026-08-20, "let AI write the whole email" mode — no template involved at
// all) — null/undefined renders as an explicit "None" block rather than throwing, so the same function
// serves both ai-select's per-template call and ai-write's template-free one.
function buildUserMessage(candidateInfo, contextText, baseTemplate, recipient, profile) {
  const baseTemplateBlock = baseTemplate
    ? `BASE TEMPLATE SUBJECT:\n${baseTemplate.subject}\n\nBASE TEMPLATE BODY:\n${baseTemplate.content}`
    : `BASE TEMPLATE:\nNone — write the email entirely in your own words.`;
  return `CANDIDATE INFO:
${candidateInfo && candidateInfo.trim() ? truncateForPrompt(candidateInfo.trim(), 4000) : "No candidate info provided — write generically but do not invent specifics."}

CANDIDATE CONTACT INFO:
${buildCandidateContactBlock(profile)}

CONTACT NAME:
${recipient.author_name && recipient.author_name.trim() ? recipient.author_name.trim() : "unknown"}

SEARCH KEYWORD:
${recipient.title && recipient.title.trim() ? recipient.title.trim() : "unknown"}

${baseTemplateBlock}

JOB POST:
${contextText || "No context provided."}`
    + (recipient.source_url ? `\n\nSOURCE URL(S):\n${recipient.source_url}` : "");
}

// Platform-managed AI (2026-08-18) — the app runs its own enterprise Gemini key server-side
// (GEMINI_API_KEY, backend/.env) rather than each user bringing their own provider/key; usage is metered
// via a credit balance instead (see lib/aiCredits.js). This used to dispatch across OpenAI/Groq/Gemini
// based on a per-user `provider` string — collapsed to Gemini-only since no UI path can select anything
// else any more, and dead multi-provider branching is exactly the kind of stale code this project's own
// docs warn against elsewhere. generateAiPersonalizedEmail, chooseTemplateForJob, and scoreJobMatch
// (below) all go through this.
// 2026-08-25: "gemini-1.5-flash" was retired from the API — every call had been 404ing (confirmed via
// GET /v1beta/models against the live key) since before this key was even configured, so this was never
// actually verified working end to end. Using the "-latest" alias instead of pinning a version, on
// purpose — this exact bug (a hardcoded model name silently going stale with a 404 that only shows up in
// server logs, invisible to the candidate) is the class of bug worth designing away, not just fixing once.
const GEMINI_MODEL = "gemini-flash-latest";

// Rate limiting (2026-08-25, operator ask — "we need to have the API rate limiting") — every one of this
// backend's three workers (automail, batchSend, scraper) can loop over many recipients/posts in one run,
// each potentially calling this function; nothing previously throttled *between* those calls, so a batch
// of N pending items fired N real Gemini requests back-to-back with zero spacing. A single in-process
// minimum-interval gate wrapping the actual network attempt (below) is the one choke point every call site
// goes through, so it protects all three workers without duplicating logic in each. Deliberately placed
// AFTER the missing-key check — that's a local, zero-cost fail (never reaches Gemini, so it doesn't burn
// any real quota), and throttling it too would just add dead latency for every pending item with no
// protective benefit. Conservative default (safely under Gemini 1.5 Flash's free-tier 15 RPM even with
// zero other traffic) since the actual billing tier isn't confirmed — override via GEMINI_MIN_INTERVAL_MS
// once it is. This only throttles within this one Node process; it does not coordinate with the frontend's
// own copy in aiClient.ts (a separate, serverless process) — the existing 429 backoff below is the safety
// net for that residual overlap.
const MIN_GEMINI_INTERVAL_MS = process.env.GEMINI_MIN_INTERVAL_MS ? parseInt(process.env.GEMINI_MIN_INTERVAL_MS, 10) : 4200;
let lastGeminiCallAt = 0;
async function throttleGeminiCall() {
  const wait = lastGeminiCallAt + MIN_GEMINI_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastGeminiCallAt = Date.now();
}

// `temperature` (2026-08-18, the AI tab) — 0-1, user-configurable, defaults to 0.4 if not passed (a
// caller that hasn't been updated yet, or an undefined app_state row for a brand-new user).
async function callAiJson(systemPrompt, userPrompt, temperature) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured on the server.");

  let retries = 3;
  let delay = 2000;

  for (let attempt = 1; attempt <= retries; attempt++) {
    await throttleGeminiCall();
    try {
      const baseUrl = process.env.GEMINI_API_URL || `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
      const url = `${baseUrl}?key=${apiKey}`;
      // 20s timeout (2026-08-25) — this runs inside a `for (const user of users)` loop across every
      // automated user in one process (automail.worker.js/scraper.worker.js); an unbounded hang on one
      // user's Gemini call would otherwise stall every other user's automation behind it too.
      const res = await axios.post(url, {
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: { responseMimeType: "application/json", temperature: typeof temperature === "number" ? temperature : 0.4 }
      }, { timeout: 20000 });
      return JSON.parse(res.data.candidates[0].content.parts[0].text);
    } catch (error) {
      if (error.response && error.response.status === 429 && attempt < retries) {
        await sleep(delay);
        delay *= 2; // exponential backoff
        continue;
      }
      throw error;
    }
  }
}

// "ai-write" send mode (2026-08-20, restored — was dropped 2026-08-19, then brought back per operator
// ask) — writes subject+body entirely from scratch, no template involved (`baseTemplate` is passed as
// null from both workers in this mode). Called from automail.worker.js/batchSend.worker.js.
async function generateAiPersonalizedEmail(candidateInfo, recipient, contextText, baseTemplate, profile, temperature) {
  const prompt = buildUserMessage(candidateInfo, contextText, baseTemplate, recipient, profile);
  return callAiJson(JOB_APPLICATION_SYSTEM_PROMPT, prompt, temperature);
}

// "ai-select" send mode (2026-08-19) — AI picks which of the role's OWN, user-written templates best
// fits a specific job, rather than writing anything itself. A classification call, not generation: the
// output is always one of the given template ids, never new prose, so there's no hallucination risk in
// what actually gets sent — see docs/architecture.md's "Email Templates redesign" section.
const TEMPLATE_CHOICE_SYSTEM_PROMPT = `You choose which ONE of a candidate's own pre-written email templates best fits a specific job opportunity. You never write, edit, or rephrase any email content — you only pick one of the given options by its id. Your only output is a single JSON object — no markdown, no commentary.

You will be given:
- ROLE — the job role/title these templates were written for.
- TEMPLATES — a numbered list of the candidate's own templates, each with its id, label, subject, and the start of its body.
- JOB POST — raw scraped text of the specific opportunity being applied to. It may be noisy, partial, or generic.

Pick whichever template's tone, framing, and subject best fit JOB POST. If JOB POST has too little signal to meaningfully prefer one over another, pick the first template in the list.

Output ONLY this JSON shape: {"templateId": "<the chosen template's id, copied exactly>", "reasoning": "<one short sentence, under 160 characters>"}`;

function buildTemplateChoicePrompt(templates, roleLabel, contextText) {
  const list = templates
    .map((t, i) => `${i + 1}. id: ${t.id}\nLabel: ${t.label}\nSubject: ${t.subject || "(no subject)"}\nBody (start): ${(t.content || "").slice(0, 200)}`)
    .join("\n\n");
  return `ROLE:
${roleLabel && roleLabel.trim() ? roleLabel.trim() : "unknown"}

TEMPLATES:
${list}

JOB POST:
${contextText && contextText.trim() ? contextText.trim() : "No text was captured for this post."}`;
}

// Returns the chosen template row (from `templates`, unmodified) or null when there's nothing to choose
// (empty pool) or the AI response didn't name a real id — callers should fall back to the pool's first
// template on null, never block a send over a picker failure. A single-template pool skips the AI call
// entirely — there's nothing to choose between.
async function chooseTemplateForJob(templates, roleLabel, contextText, temperature) {
  if (!templates || templates.length === 0) return null;
  if (templates.length === 1) return templates[0];
  const prompt = buildTemplateChoicePrompt(templates, roleLabel, contextText);
  const result = await callAiJson(TEMPLATE_CHOICE_SYSTEM_PROMPT, prompt, temperature);
  if (!result || typeof result.templateId !== "string") return null;
  return templates.find((t) => t.id === result.templateId) || null;
}

// JAMS job-match scoring (2026-08-18). Scraped posts carry no structured job data — context_text is a
// bounded, best-effort free-text snippet, not a parsed listing — so "matching a role's rules" has to be an
// AI read of that text judged against the role's structured criteria, not a SQL comparison. See
// docs/memory.md and docs/architecture.md's "Job matching" section.
const JOB_MATCH_SYSTEM_PROMPT = `You judge how well a scraped LinkedIn post matches a candidate's job-search criteria. Your only output is a single JSON object — no markdown, no commentary.

You will be given:
- JOB POST — raw scraped text of a LinkedIn post. It is an unstructured social-media snippet, NOT a structured job listing — it may be incomplete, noisy, or simply not mention some criteria at all.
- CANDIDATE'S CRITERIA — only the specific things the candidate actually set for this role. Anything not listed means the candidate has no preference on it.

Score how well JOB POST fits CANDIDATE'S CRITERIA on a 0-100 scale:
- Score high only when the post's own text actually supports a match — never assume a criterion is satisfied just because the post doesn't contradict it. If the post is silent on a criterion, treat it as neutral/unknown, not a pass or a fail.
- Score low when the post's text actively conflicts with a criterion (e.g. explicitly on-site when the candidate wants remote-only, or a stated salary clearly below the candidate's minimum).
- If JOB POST has barely any signal at all (too short, unrelated, or clearly not a real opportunity), score low and say so.

Output ONLY this JSON shape: {"score": <integer 0-100>, "reasoning": "<one short sentence, under 160 characters, citing the specific thing(s) that drove the score>"}`;

// Only lists criteria the candidate actually set (an all-'any'/empty role has nothing worth asking the
// model to check) — returns null when there's genuinely nothing to score against, so the caller can skip
// the AI call entirely rather than spend a call producing a meaningless score.
function buildRoleCriteriaBlock(role) {
  const r = role || {};
  const lines = [];
  if (r.work_mode && r.work_mode !== "any") lines.push(`Work mode: ${r.work_mode}`);
  if (r.employment_type && r.employment_type !== "any") lines.push(`Employment type: ${r.employment_type}`);
  if (r.company_size && r.company_size !== "any") lines.push(`Company size: ${r.company_size}`);
  if (r.visa_sponsorship && r.visa_sponsorship !== "any") lines.push(`Visa sponsorship: ${r.visa_sponsorship}`);
  if (r.salary_min != null || r.salary_max != null) {
    const currency = r.salary_currency || "USD";
    const period = r.salary_period || "annual";
    const min = r.salary_min != null ? r.salary_min : "(no min)";
    const max = r.salary_max != null ? r.salary_max : "(no max)";
    lines.push(`Salary expectation: ${currency} ${min}-${max} (${period})`);
  }
  if (Array.isArray(r.preferred_locations) && r.preferred_locations.length > 0) {
    lines.push(`Preferred location(s): ${r.preferred_locations.join(", ")}`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

// Returns { score: 0-100, reasoning: string } or null when there's nothing to score (no real criteria set
// on the role) or the AI response didn't come back in the expected shape — callers should treat null as
// "leave match_score unset", never as a 0.
async function scoreJobMatch(contextText, sourceUrl, role, temperature) {
  const criteria = buildRoleCriteriaBlock(role);
  if (!criteria) return null;

  const prompt = `JOB POST:
${contextText && contextText.trim() ? contextText.trim() : "No text was captured for this post."}${sourceUrl ? `

SOURCE URL:
${sourceUrl}` : ""}

CANDIDATE'S CRITERIA:
${criteria}`;

  const result = await callAiJson(JOB_MATCH_SYSTEM_PROMPT, prompt, temperature);
  if (!result || typeof result.score !== "number" || Number.isNaN(result.score)) return null;
  const score = Math.max(0, Math.min(100, Math.round(result.score)));
  const reasoning = typeof result.reasoning === "string" ? result.reasoning.slice(0, 200).trim() : "";
  return { score, reasoning };
}

module.exports = {
  generateAiPersonalizedEmail,
  chooseTemplateForJob,
  applyPlaceholders,
  hasUnresolvedPlaceholders,
  scoreJobMatch,
};
