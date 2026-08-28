// Deterministic, free job-match scoring (2026-08-28, Phase 2 task 1 — operator ask: "work on the algorithm
// first," AI should supplement it, not be the sole engine). Every function here is pure and synchronous —
// no DB, no network — so it's trivially hand-verifiable, which matters since this repo has zero tests
// anywhere. See docs/memory.md / the approved plan for the full design rationale.
//
// Mirrors ai.service.js's JOB_MATCH_SYSTEM_PROMPT semantics as closely as regex/string matching can:
// exclude keywords dominate everything else, structured criteria only count for/against a post when its
// own text actually says something (silence is neutral, never a pass or a fail), and free-text
// ai_instructions can never be resolved algorithmically at all — that one always needs real AI judgment.

// Same gate scraper.worker.js used to define locally — "is this role worth scoring against at all," AI or
// algorithmic. An all-'any'/empty role has nothing for either engine to check.
function roleHasCriteria(role) {
  if (!role) return false;
  return Boolean(
    (Array.isArray(role.work_modes) && role.work_modes.length > 0) ||
    (Array.isArray(role.employment_types) && role.employment_types.length > 0) ||
    (Array.isArray(role.company_sizes) && role.company_sizes.length > 0) ||
    (role.visa_sponsorship && role.visa_sponsorship !== "any") ||
    role.salary_min != null ||
    role.salary_max != null ||
    (Array.isArray(role.preferred_locations) && role.preferred_locations.length > 0) ||
    (Array.isArray(role.exclude_keywords) && role.exclude_keywords.length > 0) ||
    (role.ai_instructions && role.ai_instructions.trim())
  );
}

// Narrower than roleHasCriteria — does the role have anything the ALGORITHM specifically can check?
// Excludes company_sizes (LinkedIn post text almost never states headcount) and visa_sponsorship (real but
// noisier/rarer phrasing than work-mode/employment-type vocab — stays AI-only for v1). ai_instructions
// itself is still arbitrary free text a regex can't read directly, BUT (2026-08-28 follow-up) once it's
// been translated into a cached match_keywords_positive/negative list (see ai.service.js's
// generateMatchKeywords, wired in by scraper.worker.js's ensureMatchKeywords), THAT list is something this
// algorithm can check, same as any other field — so a role with ONLY ai_instructions set (no structured
// fields at all) now correctly counts as having algorithmic criteria once generation has succeeded at
// least once. Before that (or if generation keeps failing), this stays false for such a role, same as
// before this follow-up.
function roleHasAlgorithmicCriteria(role) {
  const r = role || {};
  return Boolean(
    (Array.isArray(r.work_modes) && r.work_modes.length > 0) ||
    (Array.isArray(r.employment_types) && r.employment_types.length > 0) ||
    r.salary_min != null ||
    r.salary_max != null ||
    (Array.isArray(r.preferred_locations) && r.preferred_locations.length > 0) ||
    (Array.isArray(r.exclude_keywords) && r.exclude_keywords.length > 0) ||
    (r.ai_instructions && r.ai_instructions.trim() &&
      ((Array.isArray(r.match_keywords_positive) && r.match_keywords_positive.length > 0) ||
       (Array.isArray(r.match_keywords_negative) && r.match_keywords_negative.length > 0)))
  );
}

const BASELINE_SCORE = 50; // "no signal either way" — matches the AI prompt's own "silence is neutral" rule
const EXCLUDE_KEYWORD_SCORE = 10; // hard override, short-circuits everything else — mirrors the AI's 0-15 band

// Weights favor high-confidence boolean signals (work mode / employment type = clean, stable regex
// vocabulary) over the fragile numeric one (salary parsing from noisy scraped text). aiMatchKeyword (2026-
// 08-28 follow-up) deliberately reuses workMode's own top magnitude, repurposed positive — ai_instructions
// is the AI prompt's own explicitly highest-priority signal, so outranking workMode's weight is intentional.
// BASELINE_SCORE + aiMatchKeyword.match lands exactly on the default algo_match_escalate_high threshold (80,
// see globalSettings.js) — a role with only ai_instructions set and one clean keyword hit is enough, on its
// own, to skip AI escalation entirely under default settings.
const WEIGHTS = {
  workMode: { match: 15, conflict: -30 },
  employmentType: { match: 15, conflict: -25 },
  salary: { match: 10, conflict: -20 },
  location: { match: 10 }, // match-only, see classifyLocation
  keywordOverlap: { match: 5 },
  aiMatchKeyword: { match: 30 },
};

const WORK_MODE_PATTERNS = {
  remote: /\b(fully\s+)?remote\b|\bwork[\s-]from[\s-]home\b|\bwfh\b/i,
  onsite: /\bon[- ]?site\b|\bin[- ]office\b|\bin[- ]person\b|\brelocation\s+required\b/i,
  hybrid: /\bhybrid\b/i,
};
const EMPLOYMENT_TYPE_PATTERNS = {
  "full-time": /\bfull[- ]?time\b/i,
  "part-time": /\bpart[- ]?time\b/i,
  contract: /\bcontract(?:or)?\b|\bfreelance[r]?\b|\bC2C\b|\b1099\b/i,
  internship: /\bintern(?:ship)?\b/i,
};

// Salary: requires an explicit currency marker before a number — a bare "40" or "2024" in post text is
// never treated as a salary. Range and single-value variants; a trailing 'k' means *1000. Best-effort only,
// hence the lowest weight in WEIGHTS above.
const CURRENCY_TOKEN = "(USD|US\\$|\\$|£|€|GBP|EUR|PKR|Rs\\.?)";
// A plain digit run (`[\d,]+`), not the more "proper-looking" `\d{1,3}(?:,\d{3})*` grouped-triplet form —
// that version silently under-matches ("60000" -> just "600") on any plain, comma-free number, which is
// the common case in scraped post text, not the exception. Caught by hand-verification against real
// posts, not guessed (see the plan's verification section).
const SALARY_NUM = "([\\d,]+(?:\\.\\d+)?)(k)?";
const SALARY_RANGE_RE = new RegExp(`${CURRENCY_TOKEN}\\s?${SALARY_NUM}\\s?(?:-|–|to)\\s?${CURRENCY_TOKEN}?\\s?${SALARY_NUM}`, "i");
const SALARY_SINGLE_RE = new RegExp(`${CURRENCY_TOKEN}\\s?${SALARY_NUM}`, "i");
const SALARY_PERIOD_RE = /\/\s?(hr|hour|yr|year|annum|mo|month)\b/i;

const PERIOD_TO_ANNUAL_MULTIPLIER = { hourly: 2080, monthly: 12, annual: 1 };

function parseSalaryNum(numStr, kFlag) {
  const n = parseFloat(numStr.replace(/,/g, ""));
  if (Number.isNaN(n)) return null;
  return kFlag ? n * 1000 : n;
}

function detectedPeriodFromText(text) {
  const m = text.match(SALARY_PERIOD_RE);
  if (!m) return null;
  const token = m[1].toLowerCase();
  if (token === "hr" || token === "hour") return "hourly";
  if (token === "mo" || token === "month") return "monthly";
  return "annual"; // yr/year/annum
}

// Returns "match" | "conflict" | "silent" — never guesses when parsing is ambiguous.
function classifySalary(text, role) {
  const rangeMatch = text.match(SALARY_RANGE_RE);
  const singleMatch = !rangeMatch && text.match(SALARY_SINGLE_RE);
  if (!rangeMatch && !singleMatch) return "silent";

  let low;
  let high;
  if (rangeMatch) {
    low = parseSalaryNum(rangeMatch[2], rangeMatch[3]);
    high = parseSalaryNum(rangeMatch[5], rangeMatch[6]);
    if (high != null && low != null && high < low) [low, high] = [high, low];
  } else {
    const v = parseSalaryNum(singleMatch[2], singleMatch[3]);
    low = v;
    high = v;
  }
  if (low == null && high == null) return "silent";

  // Normalize the DETECTED figure to the role's own salary_period so they're comparable — only when a
  // period was actually stated in the post text; otherwise we'd be guessing which period the post meant.
  const detectedPeriod = detectedPeriodFromText(text);
  const rolePeriod = role.salary_period || "annual";
  if (detectedPeriod && detectedPeriod !== rolePeriod) {
    const multiplier = PERIOD_TO_ANNUAL_MULTIPLIER[detectedPeriod] / PERIOD_TO_ANNUAL_MULTIPLIER[rolePeriod];
    if (low != null) low *= multiplier;
    if (high != null) high *= multiplier;
  } else if (!detectedPeriod && rolePeriod !== "annual") {
    // No period stated in the post and the role isn't annual — too ambiguous to compare confidently.
    return "silent";
  }

  const roleMin = role.salary_min;
  const roleMax = role.salary_max;
  if (roleMin == null && roleMax == null) return "silent";

  const postMax = high != null ? high : low;
  const postMin = low != null ? low : high;
  // Conflict only when the ranges genuinely don't overlap at all.
  if (roleMax != null && postMin != null && postMin > roleMax) return "conflict";
  if (roleMin != null && postMax != null && postMax < roleMin) return "conflict";
  return "match";
}

// A negation word within ~30 chars before a pattern hit means it wasn't actually a positive mention —
// "not open to remote work" must not register as "remote: detected." Caught via hand-verification (a real
// false positive: "Not open to remote or contract work" was scoring as a work-mode MATCH before this).
// Still a heuristic, not real language understanding — same accepted-risk convention as the exclude-keyword
// substring match elsewhere in this file.
const NEGATION_RE = /\b(not|no|never|without|excluding|except|isn'?t|aren'?t|don'?t|doesn'?t|won'?t)\b[^.!?\n]{0,30}$/i;

function detectFromPatterns(text, patternsByValue) {
  const detected = [];
  for (const [value, re] of Object.entries(patternsByValue)) {
    const globalRe = new RegExp(re.source, re.flags.replace("g", "") + "g");
    let match;
    let hasPositiveMention = false;
    while ((match = globalRe.exec(text)) !== null) {
      const precedingWindow = text.slice(Math.max(0, match.index - 35), match.index);
      if (!NEGATION_RE.test(precedingWindow)) {
        hasPositiveMention = true;
        break;
      }
      if (globalRe.lastIndex === match.index) globalRe.lastIndex++; // guard against zero-width matches
    }
    if (hasPositiveMention) detected.push(value);
  }
  return detected;
}

// MATCH if any detected value intersects the role's selected set (a post offering "hybrid or remote" when
// the role wants remote shouldn't false-conflict on the other option mentioned). CONFLICT only when values
// were detected but none intersect. SILENT when the post's text didn't state this signal at all.
function classifyMultiSelect(detected, roleValues) {
  if (detected.length === 0) return "silent";
  return detected.some((v) => roleValues.includes(v)) ? "match" : "conflict";
}

function classifyLocation(text, roleLocations) {
  const lower = text.toLowerCase();
  return roleLocations.some((loc) => loc && lower.includes(loc.toLowerCase())) ? "match" : "silent";
}

// Checks the user's own exclude_keywords first, then (2026-08-28 follow-up) AI-derived negative keywords —
// both are plain substring checks, no negation-awareness, same accepted-limitation convention throughout
// this file. Returns { term, source: "user" | "ai_instructions" } or null.
function findExcludeKeywordHit(text, excludeKeywords, aiNegativeKeywords) {
  const lower = text.toLowerCase();
  const userHit = (excludeKeywords || []).find((kw) => kw && lower.includes(kw.toLowerCase().trim()));
  if (userHit) return { term: userHit, source: "user" };
  const aiHit = (aiNegativeKeywords || []).find((kw) => kw && lower.includes(kw.toLowerCase().trim()));
  if (aiHit) return { term: aiHit, source: "ai_instructions" };
  return null;
}

// Gated on ai_instructions being CURRENTLY set — a role whose candidate cleared their free-text
// instructions must not keep scoring against an orphaned cached list. Staleness (instructions EDITED, not
// cleared) is deliberately NOT checked here — this function is a pure read of role's current columns, and a
// slightly-stale AI-derived list is still real signal from this candidate's own words for this same role,
// strictly better than none (same "something beats nothing" precedent as the AI-failure algorithmic
// fallback in scraper.worker.js). Staleness only ever gates whether to RE-generate (see ai.service.js's
// matchKeywordsAreStale) — never whether to USE what's already cached.
function findAiPositiveKeywordHit(text, role) {
  if (!role.ai_instructions || !role.ai_instructions.trim()) return null;
  const lower = text.toLowerCase();
  return (role.match_keywords_positive || []).find((kw) => kw && lower.includes(kw.toLowerCase().trim())) || null;
}

// The one exported scoring entry point. Returns null when there's nothing algorithmic to check at all
// (caller falls back to AI-only or leaves the post unscored) — same "nothing to say" convention as
// ai.service.js's buildRoleCriteriaBlock.
function computeAlgorithmicMatch(contextText, role) {
  const r = role || {};
  if (!roleHasAlgorithmicCriteria(r)) return null;

  const text = (contextText || "").trim();
  if (!text) {
    return { score: BASELINE_SCORE, reasoning: "Algorithmic: no post text captured to check.", signals: {} };
  }

  const aiInstructionsSet = Boolean(r.ai_instructions && r.ai_instructions.trim());
  const excludeHit = findExcludeKeywordHit(text, r.exclude_keywords, aiInstructionsSet ? r.match_keywords_negative : null);
  if (excludeHit) {
    const label = excludeHit.source === "ai_instructions"
      ? `matches an excluded topic from your AI instructions ("${excludeHit.term}")`
      : `excludes "${excludeHit.term}"`;
    return {
      score: EXCLUDE_KEYWORD_SCORE,
      reasoning: `Algorithmic: ${label} — found in the post text.`,
      signals: { excludeKeywordHit: excludeHit.term, excludeKeywordSource: excludeHit.source },
    };
  }

  let score = BASELINE_SCORE;
  const signals = {};
  const parts = [];

  if (Array.isArray(r.work_modes) && r.work_modes.length > 0) {
    const detected = detectFromPatterns(text, WORK_MODE_PATTERNS);
    const cls = classifyMultiSelect(detected, r.work_modes);
    signals.workMode = cls;
    if (cls !== "silent") {
      score += WEIGHTS.workMode[cls];
      parts.push(`work mode ${cls}`);
    }
  }

  if (Array.isArray(r.employment_types) && r.employment_types.length > 0) {
    const detected = detectFromPatterns(text, EMPLOYMENT_TYPE_PATTERNS);
    const cls = classifyMultiSelect(detected, r.employment_types);
    signals.employmentType = cls;
    if (cls !== "silent") {
      score += WEIGHTS.employmentType[cls];
      parts.push(`employment type ${cls}`);
    }
  }

  if (r.salary_min != null || r.salary_max != null) {
    const cls = classifySalary(text, r);
    signals.salary = cls;
    if (cls !== "silent") {
      score += WEIGHTS.salary[cls];
      parts.push(`salary ${cls}`);
    }
  }

  if (Array.isArray(r.preferred_locations) && r.preferred_locations.length > 0) {
    const cls = classifyLocation(text, r.preferred_locations);
    signals.location = cls;
    if (cls === "match") {
      score += WEIGHTS.location.match;
      parts.push("location match");
    }
  }

  if (Array.isArray(r.keywords) && r.keywords.some((k) => k && text.toLowerCase().includes(k.toLowerCase()))) {
    score += WEIGHTS.keywordOverlap.match;
  }

  const aiPositiveHit = findAiPositiveKeywordHit(text, r);
  if (aiPositiveHit) {
    score += WEIGHTS.aiMatchKeyword.match;
    signals.aiInstructionsKeyword = "match";
    parts.push(`AI instructions keyword match ("${aiPositiveHit}")`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const reasoning = `Algorithmic: ${parts.length > 0 ? parts.join(", ") : "no structured signals detected in post text"} (${score}/100).`;
  return { score, reasoning: reasoning.slice(0, 200), signals };
}

// Pure escalation policy — no I/O, easy to hand-verify against a truth table. hasFreshMatchKeywords
// (2026-08-28 follow-up) is computed by the caller (scraper.worker.js, which already imports both this
// service and ai.service.js's matchKeywordsAreStale) — kept out of this file to preserve its "pure, no DB,
// no network" claim even though matchKeywordsAreStale itself happens to also be pure.
function shouldEscalateToAI(algoResult, role, { aiEnabled, remainingCredits, lowThreshold, highThreshold, hasFreshMatchKeywords }) {
  if (!aiEnabled || !(remainingCredits > 0)) return false;
  const hasAiInstructions = Boolean(role && role.ai_instructions && role.ai_instructions.trim());
  // Free text can't be resolved by regex directly — but once it's been translated into a fresh, non-empty
  // cached keyword list (see ai.service.js's generateMatchKeywords), THAT list is something
  // computeAlgorithmicMatch can check, same as any other signal, and this role falls through to the normal
  // score-band check below instead of always escalating. Bootstrap/failure case (no usable keywords yet)
  // keeps today's behavior: escalate every post until/unless that changes.
  if (hasAiInstructions && !hasFreshMatchKeywords) return true;
  if (!algoResult) return true; // nothing algorithmic to go on (e.g. role only has company_sizes set)
  if (algoResult.score <= lowThreshold || algoResult.score >= highThreshold) return false; // confident either way
  return true; // borderline — let AI break the tie
}

module.exports = {
  roleHasCriteria,
  roleHasAlgorithmicCriteria,
  computeAlgorithmicMatch,
  shouldEscalateToAI,
};
