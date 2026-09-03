const axios = require("axios");
const { logAiUsage } = require("../lib/aiUsage");

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
  // Follow-up-specific tokens (2026-08-31) — resolve safely in ANY template, not just follow-up ones: a
  // regular first-touch template using {{last_sent_date}} just renders blank (no prior send yet), same
  // "blank rather than guessed" tolerance as every other token here. {{follow_up_number}} is derived from
  // recipient.follow_up_count (0 on the initial send, 0/1/2 while a follow-up worker resolves slot 1/2/3),
  // so it's meaningful specifically when a follow-up template/prompt uses it, harmless elsewhere.
  const lastSentDate = recipient.last_sent_at ? new Date(recipient.last_sent_at).toLocaleDateString() : "";
  const followUpNumber = String((recipient.follow_up_count || 0) + 1);
  return text
    .replaceAll("{{title}}", recipient.title || "")
    .replaceAll("{{name}}", recipient.author_name || "")
    .replaceAll("{{email}}", recipient.email)
    .replaceAll("{{candidate_name}}", p.name || "")
    .replaceAll("{{candidate_email}}", p.email || "")
    .replaceAll("{{candidate_phone}}", p.phone || "")
    .replaceAll("{{candidate_portfolio}}", p.portfolioUrl || "")
    .replaceAll("{{candidate_resume_link}}", p.resumeUrl || "")
    .replaceAll("{{last_sent_date}}", lastSentDate)
    .replaceAll("{{follow_up_number}}", followUpNumber);
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
// `userId`/`callType` (2026-08-29, cost metering) — optional, purely for usage logging (see lib/aiUsage.js);
// every real caller below passes both, but they're optional here so this function never *requires* a user
// context to work. Logging never affects what this function returns or throws — see the try/catch around it.
async function callAiJson(systemPrompt, userPrompt, temperature, userId, callType) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured on the server.");

  let retries = 4;
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
      // Log right after the response arrives, before JSON.parse — tokens were spent whether or not the
      // model's own output happens to parse cleanly. Awaited, but never allowed to fail the actual AI
      // call: a logging hiccup should never turn a successful Gemini response into a thrown error.
      try {
        await logAiUsage(userId, callType, res.data.usageMetadata, GEMINI_MODEL);
      } catch (logErr) {
        console.error(`[ai.service] AI usage logging failed (call itself succeeded): ${logErr.message}`);
      }
      return JSON.parse(res.data.candidates[0].content.parts[0].text);
    } catch (error) {
      // 429 (rate limited) and 503 (Gemini's own "high demand, try again later" — confirmed live
      // 2026-08-28: every single call was failing this way, and this branch previously only covered
      // 429, so a Gemini capacity blip silently killed matching/personalization outright with zero
      // retry) both mean "try again shortly," not "this request is broken" — 502/504 are the same
      // class of transient gateway failure. Anything else (400 malformed request, 403 bad key, etc.)
      // is a real error and should still fail immediately, not retry into the same wall 4 times.
      const status = error.response && error.response.status;
      const isTransient = status === 429 || status === 503 || status === 502 || status === 504;
      if (isTransient && attempt < retries) {
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
async function generateAiPersonalizedEmail(candidateInfo, recipient, contextText, baseTemplate, profile, temperature, userId) {
  const prompt = buildUserMessage(candidateInfo, contextText, baseTemplate, recipient, profile);
  return callAiJson(JOB_APPLICATION_SYSTEM_PROMPT, prompt, temperature, userId, "generate_personalized_email");
}

// Automated follow-ups (2026-08-31, MVP push) — up to 3 per recipient, AI-written by default (a candidate
// can instead link a fixed template per slot, see followUp.worker.js — that path never reaches this
// function). `previousEmail` is that recipient's most recent sent email ({subject, content}, read from
// automailsend_sent_log by the caller) so the model can write a genuine continuation instead of repeating
// the original pitch — same {subject, content} shape as generateAiPersonalizedEmail's `baseTemplate` param,
// reused here as "what was already said" rather than "starting-point wording."
const FOLLOW_UP_SYSTEM_PROMPT = `You write a brief, natural follow-up email on behalf of a job candidate who reached out about an opportunity and hasn't heard back. Your only output is a single JSON object — no markdown, no commentary.

You will be given, in the user message:
- CANDIDATE INFO / CANDIDATE CONTACT INFO / CONTACT NAME / SEARCH KEYWORD / JOB POST — same meaning as a first-touch email; use them the same way (real data only, never invent).
- FOLLOW-UP NUMBER — which follow-up this is: 1, 2, or 3 (of a max of 3).
- LAST SENT ON — the date the candidate's previous email (or previous follow-up) went out.
- PREVIOUS EMAIL SUBJECT / PREVIOUS EMAIL BODY — the actual email already sent to this contact, so you can reference it naturally rather than repeating it.

Decide first: is this still worth following up on (JOB POST is a real, plausibly-still-relevant opportunity)? If not (spam, clearly stale/filled, too vague), respond with exactly: {"skip": true, "reason": "<one short sentence>"}. Otherwise, continue below.

Write the follow-up:
1. Open by referencing that this is a follow-up to the earlier email (using LAST SENT ON naturally, e.g. "following up on my note from..." — don't just restate the date mechanically).
2. Do NOT repeat the original pitch verbatim — add one new, brief angle (restate interest concisely, or surface one detail from CANDIDATE INFO not emphasized before) rather than resending the same content.
3. The later the follow-up number, the shorter and lower-pressure the tone should be — follow-up 3 should read as a brief, polite final check-in, not an escalation.
4. Never invent experience, credentials, or facts about the candidate that aren't in CANDIDATE INFO. Never output bracket/brace placeholders like [Name] or {{title}} — every field given is either real (use it) or unknown (omit).
5. Sign off with the candidate's real name if given; include only whichever contact channels CANDIDATE CONTACT INFO actually lists.
6. Keep it short — a follow-up should be noticeably briefer than a first-touch email, a few sentences at most.

Output ONLY this JSON shape: {"subject": "<email subject>", "body": "<the email body, plain text>"}`;

function buildFollowUpUserMessage(candidateInfo, contextText, previousEmail, recipient, profile, followUpNumber) {
  const lastSentBlock = recipient.last_sent_at
    ? new Date(recipient.last_sent_at).toLocaleDateString()
    : "unknown";
  const previousEmailBlock = previousEmail
    ? `PREVIOUS EMAIL SUBJECT:\n${previousEmail.subject || "(no subject)"}\n\nPREVIOUS EMAIL BODY:\n${previousEmail.content || previousEmail.body || "(no body)"}`
    : `PREVIOUS EMAIL:\nNot available — write a generic but genuine follow-up.`;
  return `CANDIDATE INFO:
${candidateInfo && candidateInfo.trim() ? truncateForPrompt(candidateInfo.trim(), 4000) : "No candidate info provided — write generically but do not invent specifics."}

CANDIDATE CONTACT INFO:
${buildCandidateContactBlock(profile)}

CONTACT NAME:
${recipient.author_name && recipient.author_name.trim() ? recipient.author_name.trim() : "unknown"}

SEARCH KEYWORD:
${recipient.title && recipient.title.trim() ? recipient.title.trim() : "unknown"}

FOLLOW-UP NUMBER:
${followUpNumber} of 3

LAST SENT ON:
${lastSentBlock}

${previousEmailBlock}

JOB POST:
${contextText || "No context provided."}`
    + (recipient.source_url ? `\n\nSOURCE URL(S):\n${recipient.source_url}` : "");
}

async function generateFollowUpEmail(candidateInfo, recipient, contextText, previousEmail, profile, temperature, userId, followUpNumber) {
  const prompt = buildFollowUpUserMessage(candidateInfo, contextText, previousEmail, recipient, profile, followUpNumber);
  return callAiJson(FOLLOW_UP_SYSTEM_PROMPT, prompt, temperature, userId, "generate_follow_up_email");
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
async function chooseTemplateForJob(templates, roleLabel, contextText, temperature, userId) {
  if (!templates || templates.length === 0) return null;
  if (templates.length === 1) return templates[0];
  const prompt = buildTemplateChoicePrompt(templates, roleLabel, contextText);
  const result = await callAiJson(TEMPLATE_CHOICE_SYSTEM_PROMPT, prompt, temperature, userId, "choose_template");
  if (!result || typeof result.templateId !== "string") return null;
  return templates.find((t) => t.id === result.templateId) || null;
}

// JAMS job-match scoring (2026-08-18). Scraped posts carry no structured job data — context_text is a
// bounded, best-effort free-text snippet, not a parsed listing — so "matching a role's rules" has to be an
// AI read of that text judged against the role's structured criteria, not a SQL comparison. See
// docs/memory.md and docs/architecture.md's "Job matching" section.
// Extended 2026-08-25 (operator ask) — the candidate's own search keywords are a blunt instrument on
// their own ("someone calls it specialization, someone calls it engineer"), so the real filter is this AI
// read of the post's actual text against three layers, checked in priority order:
//  1. AI INSTRUCTIONS (candidate's own free text, e.g. "only match low-code/no-code roles") — highest
//     priority, overrides both layers below when it conflicts with either.
//  2. EXCLUDE KEYWORDS/TOPICS — score low when the post is genuinely about one of these, even though it
//     surfaced from an Include Keyword search.
//  3. CANDIDATE'S CRITERIA — the structured work-mode/salary/etc. fields, unchanged from before.
const JOB_MATCH_SYSTEM_PROMPT = `You judge how well a scraped LinkedIn post matches a candidate's job-search criteria, and whether it should be filtered out entirely. Your only output is a single JSON object — no markdown, no commentary.

You will be given, in priority order (a higher one overrides a lower one when they conflict):
- AI INSTRUCTIONS (optional) — free-text instructions written by the candidate themselves. Highest priority of everything below — if these conflict with EXCLUDE KEYWORDS/TOPICS or CANDIDATE'S CRITERIA, follow AI INSTRUCTIONS.
- EXCLUDE KEYWORDS/TOPICS (optional) — if JOB POST is genuinely about any of these (not just a coincidental word overlap), score it low (0-15) and say which one drove it, unless AI INSTRUCTIONS overrides that.
- CANDIDATE'S CRITERIA — only the specific things the candidate actually set for this role. Anything not listed means the candidate has no preference on it.
- JOB POST — raw scraped text of a LinkedIn post. It is an unstructured social-media snippet, NOT a structured job listing — it may be incomplete, noisy, or simply not mention some criteria at all. Job titles vary a lot in how people phrase them (e.g. "automation specialist" vs "automation engineer") — judge the actual role being described, not just literal keyword overlap.

Score how well JOB POST fits, on a 0-100 scale:
- Score high only when the post's own text actually supports a match — never assume a criterion is satisfied just because the post doesn't contradict it. If the post is silent on a criterion, treat it as neutral/unknown, not a pass or a fail.
- Score low when the post's text actively conflicts with CANDIDATE'S CRITERIA (e.g. explicitly on-site when the candidate wants remote-only, or a stated salary clearly below the candidate's minimum).
- If JOB POST has barely any signal at all (too short, unrelated, or clearly not a real job opportunity), score low and say so.

Output ONLY this JSON shape: {"score": <integer 0-100>, "reasoning": "<one short sentence, under 160 characters, citing the specific thing(s) that drove the score>"}`;

// Only lists criteria the candidate actually set (an all-'any'/empty role has nothing worth asking the
// model to check) — returns null when there's genuinely nothing to score against, so the caller can skip
// the AI call entirely rather than spend a call producing a meaningless score.
function buildRoleCriteriaBlock(role) {
  const r = role || {};
  const lines = [];
  // work_modes/employment_types/company_sizes (2026-08-26) — all three multi-selects now; the singular
  // work_mode/employment_type/company_size columns are retired, no longer read here. Any one of the
  // listed values counts as a match, not all of them.
  if (Array.isArray(r.work_modes) && r.work_modes.length > 0) {
    lines.push(`Work mode: ${r.work_modes.join(" or ")}`);
  }
  if (Array.isArray(r.employment_types) && r.employment_types.length > 0) {
    lines.push(`Employment type: ${r.employment_types.join(" or ")}`);
  }
  if (Array.isArray(r.company_sizes) && r.company_sizes.length > 0) {
    lines.push(`Company size: ${r.company_sizes.join(" or ")}`);
  }
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

// The two new filtering signals (2026-08-25) — kept as their own small builders, separate from
// buildRoleCriteriaBlock above, since they're read by the prompt as distinct, higher-priority blocks
// rather than more structured "criteria." Both return null when unset, same "nothing to say" convention.
function buildExcludeKeywordsBlock(role) {
  const r = role || {};
  if (!Array.isArray(r.exclude_keywords) || r.exclude_keywords.length === 0) return null;
  return r.exclude_keywords.join(", ");
}
function buildAiInstructionsBlock(role) {
  const r = role || {};
  if (!r.ai_instructions || !r.ai_instructions.trim()) return null;
  // Same truncation guard as candidateInfo elsewhere in this file — this is candidate-controlled free
  // text, not a bounded scraped value.
  return truncateForPrompt(r.ai_instructions.trim(), 1000);
}

// Returns { score: 0-100, reasoning: string } or null when there's nothing to score at all (no structured
// criteria, no exclude keywords, no AI instructions) or the AI response didn't come back in the expected
// shape — callers should treat null as "leave match_score unset", never as a 0.
async function scoreJobMatch(contextText, sourceUrl, role, temperature, userId) {
  const criteria = buildRoleCriteriaBlock(role);
  const excludeKeywords = buildExcludeKeywordsBlock(role);
  const aiInstructions = buildAiInstructionsBlock(role);
  if (!criteria && !excludeKeywords && !aiInstructions) return null;

  const prompt = `JOB POST:
${contextText && contextText.trim() ? contextText.trim() : "No text was captured for this post."}${sourceUrl ? `

SOURCE URL:
${sourceUrl}` : ""}
${aiInstructions ? `
AI INSTRUCTIONS (from the candidate, highest priority):
${aiInstructions}` : ""}
${excludeKeywords ? `
EXCLUDE KEYWORDS/TOPICS:
${excludeKeywords}` : ""}

CANDIDATE'S CRITERIA:
${criteria || "None set."}`;

  const result = await callAiJson(JOB_MATCH_SYSTEM_PROMPT, prompt, temperature, userId, "score_job_match");
  if (!result || typeof result.score !== "number" || Number.isNaN(result.score)) return null;
  const score = Math.max(0, Math.min(100, Math.round(result.score)));
  const reasoning = typeof result.reasoning === "string" ? result.reasoning.slice(0, 200).trim() : "";
  return { score, reasoning };
}

// Job-provider classification + clean description (2026-09-03, operator-reported bug — a job-SEEKER's own
// post got emailed as if its author were the employer). `looksLikeJobPost` (matchAlgorithm.service.js) only
// ever caught promo/ad spam that happened to match search keywords — it never asked "is the AUTHOR of this
// post an employer or a candidate," and a job-seeker's "I'm looking for a role as an engineer..." post trips
// the same HIRING_SIGNAL_RE phrasing a real employer's post would, so it sailed straight through as
// job_or_unknown. This closes that gap with a real read of the post.
//
// Deliberately BATCHED — many posts, one Gemini call — not one-call-per-post: the platform's one shared
// Gemini key is deliberately still on the free tier's 20-requests/DAY ceiling across every user
// (docs/pricing-tiers.md), so a naive per-post design could exhaust it from job-filtering alone in a single
// scrape run. Batching also doubles as the "clean caption" step the operator asked for separately ("keep the
// context short... don't generate descriptions right there... AI-based assembly just provides the filtered
// job caption as a job description") — the SAME read that classifies a post also produces its user-facing
// description, so there's no separate summarization call competing for the same scarce quota. See
// scraper.worker.js's finalizeClassifiedContacts for the caller/batching logic.
const JOB_CLASSIFY_SYSTEM_PROMPT = `You review a batch of scraped LinkedIn posts that already matched a job candidate's search keywords, and decide which ones are genuine posts from an employer/recruiter/hiring manager OFFERING a job — as opposed to a job-SEEKER's own post about looking for work, or anything else that isn't really a hiring post. Your only output is a single JSON object — no markdown, no commentary.

You will be given POSTS, a numbered list of raw scraped LinkedIn post captions (each may be noisy, partial, or contain leftover UI text like "Like Comment Share" or hashtag clusters — ignore that, judge only the substantive content).

For EACH post, decide:
- isJobProvider: true only when the post's author is clearly OFFERING a job/opportunity on behalf of a company or as a recruiter/hiring manager (e.g. "We're hiring a...", "My team is looking for...", "Reach out if you or someone you know..."). false when the author is describing THEMSELVES as the candidate/job-seeker (e.g. "I'm an engineer looking for my next role", "Open to work", "I have 5 years of experience and I'm seeking..."), or the post isn't really about a job opening at all.
- reasoning: one short sentence (under 160 characters) explaining the call — cite the specific phrase/signal that drove it.
- description: ONLY when isJobProvider is true — a clean, plain-text description of the job opportunity using ONLY facts actually stated in the post. Real line breaks between distinct facts (role/title, key requirements, location/work mode, how to apply), no invented details, no LinkedIn boilerplate ("Like Comment Share", follower counts, "See translation", hashtag clusters) carried into it. 2-5 short lines. Omit this field (or use an empty string) when isJobProvider is false.

Output ONLY this JSON shape: {"results": [{"isJobProvider": <boolean>, "reasoning": "<string>", "description": "<string>"}, ...]} — one entry per post, in the SAME order as POSTS, same length as POSTS.`;

// Per-post caption cap — this call batches many posts into ONE prompt, so per-post length matters more than
// in scoreJobMatch's single-post prompt (which doesn't truncate contextText at all). 600 chars is enough for
// a LinkedIn hiring post's substance (title, a few requirements, how to apply) while keeping a full
// CLASSIFY_BATCH_SIZE-post batch short — operator ask, "keep the context short."
const CLASSIFY_CAPTION_MAX_LEN = 600;

function buildJobClassifyPrompt(posts) {
  const list = posts
    .map((p, i) => `${i + 1}. ${truncateForPrompt((p.contextText || "").trim(), CLASSIFY_CAPTION_MAX_LEN) || "(no text captured)"}`)
    .join("\n\n");
  return `POSTS:\n${list}`;
}

// Returns an array of { isJobProvider, reasoning, description }, SAME length/order as `posts`, or null if
// the AI response didn't come back in the expected shape — caller (scraper.worker.js) fails open on null,
// same "unclassified is never a hard fail" convention as everywhere else AI touches this pipeline. A
// malformed individual entry also fails open (isJobProvider defaults true) rather than silently dropping a
// possibly-legitimate lead over one bad sub-object.
async function classifyJobPosts(posts, temperature, userId) {
  if (!Array.isArray(posts) || posts.length === 0) return null;
  const prompt = buildJobClassifyPrompt(posts);
  const result = await callAiJson(JOB_CLASSIFY_SYSTEM_PROMPT, prompt, temperature, userId, "classify_job_posts");
  if (!result || !Array.isArray(result.results) || result.results.length !== posts.length) return null;
  return result.results.map((r) => ({
    isJobProvider: r && typeof r.isJobProvider === "boolean" ? r.isJobProvider : true,
    reasoning: r && typeof r.reasoning === "string" ? r.reasoning.slice(0, 200).trim() : "",
    description: r && r.isJobProvider && typeof r.description === "string" && r.description.trim() ? r.description.trim().slice(0, 2000) : null,
  }));
}

// AI-curated match keywords (2026-08-28 follow-up, Phase 2 task 1 addendum) — translates a role's free-text
// ai_instructions into a bounded, literal keyword/phrase list a cheap substring check can use against
// future scraped post text, instead of scoreJobMatch reading the full post on every single one. Deliberately
// post-independent — NO post text is ever given to this call, only the role's own criteria — that's what
// makes it safe to run once per role instead of once per post. See matchAlgorithm.service.js's
// computeAlgorithmicMatch and scraper.worker.js's ensureMatchKeywords.
const MATCH_KEYWORDS_SYSTEM_PROMPT = `You translate a candidate's job-search criteria into two short, literal keyword/phrase lists a downstream substring-matching program (not another AI) will check against future scraped LinkedIn job posts. Your only output is a single JSON object — no markdown, no commentary.

You will be given:
- AI INSTRUCTIONS — free-text instructions written by the candidate themselves, e.g. "only low-code roles, I use N8N and Claude Code" or "exclude unpaid internships even if the keywords otherwise match." This is the only thing to translate.
- EXCLUDE KEYWORDS/TOPICS (optional) — topics the candidate already excludes by exact keyword; for context only, so you don't waste output repeating them. A separate, exact-match check already covers these — do not put them in your own output.
- CANDIDATE'S CRITERIA (optional) — structured fields (work mode, salary, etc.) already checked separately by exact rules; for context only, do not restate these as keywords either.

Your job is ONLY to expand AI INSTRUCTIONS into two literal keyword/phrase lists a plain substring search can use against a job post's raw text:
- POSITIVE: words/short phrases whose presence in a post is real, concrete evidence the post satisfies AI INSTRUCTIONS. Include close synonyms, common alternate spellings/casing a recruiter might actually type, and named tools/technologies/frameworks explicitly implied (e.g. "low-code" implies "n8n", "zapier", "make.com", "airtable", "no-code", "workflow automation").
- NEGATIVE: words/short phrases whose presence is real, concrete evidence the post CONTRADICTS or is clearly excluded by AI INSTRUCTIONS. Only include a phrase when its presence alone would be strong, near-certain evidence of a non-match — not just "the opposite" of a POSITIVE entry. When AI INSTRUCTIONS doesn't clearly rule anything out, return an empty NEGATIVE list rather than inventing one.

Hard rules:
- Every phrase must be something that could literally appear, near-verbatim, in a real job post's text — never an abstract judgment, a sentiment, or anything requiring the reasoning a human (or another AI) would need to apply. If AI INSTRUCTIONS can't be reduced to any such literal phrase at all, return both lists empty — do not force a weak guess.
- Lowercase, no surrounding punctuation, no regex syntax — plain words/phrases only, 1-4 words each.
- At most 15 phrases in POSITIVE, at most 10 in NEGATIVE. Prioritize the highest-confidence, most-specific phrases over broad/generic ones (prefer "n8n" and "zapier" over just "automation").
- Never include a phrase so short or common it would false-positive on unrelated posts (e.g. never "ai", "app", "team", "remote" alone) unless AI INSTRUCTIONS is specifically about that exact word.

Output ONLY this JSON shape: {"positive": ["<phrase>", ...], "negative": ["<phrase>", ...]}`;

// The user-prompt string doubles as the staleness fingerprint (see matchKeywordsAreStale below) — it's a
// deterministic function of exactly the inputs that drive generation, so comparing it directly is enough to
// detect "this role's criteria changed since we generated," with no hashing library (this codebase adds
// none). Returns null when there's nothing to translate — same "nothing to say" convention as
// buildRoleCriteriaBlock — which is the ai_instructions-only gate for this whole feature: exclude_keywords/
// structured fields are already exact-matched elsewhere, no AI needed to "curate" those.
function buildMatchKeywordsPrompt(role) {
  const aiInstructions = buildAiInstructionsBlock(role);
  if (!aiInstructions) return null;
  const excludeKeywords = buildExcludeKeywordsBlock(role);
  const criteria = buildRoleCriteriaBlock(role);
  return `AI INSTRUCTIONS (from the candidate, the only thing to translate):
${aiInstructions}
${excludeKeywords ? `
EXCLUDE KEYWORDS/TOPICS (context only, already exact-matched separately):
${excludeKeywords}` : ""}

CANDIDATE'S CRITERIA (context only, already checked separately):
${criteria || "None set."}`;
}

// True when the role's ai_instructions/exclude_keywords/criteria have changed since match_keywords_* was
// last generated (or nothing has been generated yet). False (never stale) when there's nothing to translate
// at all — matches buildMatchKeywordsPrompt's null case.
function matchKeywordsAreStale(role) {
  const prompt = buildMatchKeywordsPrompt(role);
  if (!prompt) return false;
  return prompt !== (role.match_keywords_source_snapshot || null);
}

const MAX_POSITIVE_MATCH_KEYWORDS = 15;
// Negative capped tighter than positive — a wrong negative silently drops a real lead via
// matchAlgorithm.service.js's hard-override exclude path, a costlier mistake than a missed positive bonus,
// so keep this list tighter/higher-confidence.
const MAX_NEGATIVE_MATCH_KEYWORDS = 10;
const MAX_MATCH_KEYWORD_LEN = 40; // chars per phrase — same "bound anything AI hands back" instinct as
                                   // this file's reasoning.slice(0, 200) above.

function sanitizeMatchKeywordList(list, maxItems) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string") continue;
    const phrase = raw.trim().toLowerCase().slice(0, MAX_MATCH_KEYWORD_LEN);
    if (!phrase || seen.has(phrase)) continue;
    seen.add(phrase);
    out.push(phrase);
    if (out.length >= maxItems) break;
  }
  return out;
}

// Returns { positive, negative, promptSnapshot } or null when there's nothing to translate (no
// ai_instructions set) or the AI response didn't come back in the expected shape. promptSnapshot is the
// exact string to persist as match_keywords_source_snapshot — callers should not rebuild it separately.
async function generateMatchKeywords(role, temperature, userId) {
  const prompt = buildMatchKeywordsPrompt(role);
  if (!prompt) return null;
  const result = await callAiJson(MATCH_KEYWORDS_SYSTEM_PROMPT, prompt, temperature, userId, "generate_match_keywords");
  if (!result || typeof result !== "object") return null;
  return {
    positive: sanitizeMatchKeywordList(result.positive, MAX_POSITIVE_MATCH_KEYWORDS),
    negative: sanitizeMatchKeywordList(result.negative, MAX_NEGATIVE_MATCH_KEYWORDS),
    promptSnapshot: prompt,
  };
}

module.exports = {
  generateAiPersonalizedEmail,
  generateFollowUpEmail,
  chooseTemplateForJob,
  applyPlaceholders,
  hasUnresolvedPlaceholders,
  scoreJobMatch,
  classifyJobPosts,
  generateMatchKeywords,
  matchKeywordsAreStale,
};
