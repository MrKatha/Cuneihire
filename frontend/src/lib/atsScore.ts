import type { ResumeData } from "@/lib/types";

// Heuristic ATS-friendliness score (2026-08-31, public resume builder) — deliberately NOT AI-powered.
// This runs on the public, unauthenticated /resume-builder page, so it has to be free and abuse-proof: a
// pure function over data already in the browser, zero network calls, zero ai_credits spent. It checks the
// same structural things a real ATS parser struggles with (missing sections, no contact info, walls of
// text with no bullets) rather than claiming to replicate a proprietary keyword-matching product — see
// docs/architecture.md's "Public resume builder" section for the reasoning.
export type AtsFinding = {
  id: string;
  label: string;
  ok: boolean;
  hint: string;
};

export type AtsResult = {
  score: number; // 0-100
  findings: AtsFinding[];
  keywordMatch: { matched: string[]; missing: string[]; percent: number } | null;
};

// Very small, deliberately generic list — this is a heuristic nudge ("did you show impact"), not a claim
// of exhaustive coverage.
const ACTION_VERBS = [
  "led", "built", "created", "designed", "developed", "managed", "launched", "improved", "increased",
  "reduced", "delivered", "implemented", "drove", "achieved", "organized", "coordinated", "analyzed",
  "optimized", "streamlined", "negotiated", "mentored", "spearheaded", "automated", "resolved",
];

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "as", "at", "by",
  "be", "this", "that", "it", "you", "we", "will", "your", "our", "their", "from", "have", "has", "not",
]);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z0-9+.#-]{1,}/g) || []).filter((w) => !STOPWORDS.has(w) && w.length > 2);
}

function bulletCount(description: string): number {
  return description.split("\n").filter((line) => /^\s*[-*]\s+/.test(line)).length;
}

export function computeAtsScore(data: ResumeData, jobDescription?: string): AtsResult {
  const findings: AtsFinding[] = [];
  let earned = 0;
  let total = 0;

  function check(id: string, label: string, ok: boolean, weight: number, hint: string) {
    total += weight;
    if (ok) earned += weight;
    findings.push({ id, label, ok, hint });
  }

  check("contact-email", "Email address present", !!data.personalInfo.email.trim(), 10,
    "Most ATS platforms reject a resume with no way to contact you.");
  check("contact-phone", "Phone number present", !!data.personalInfo.phone.trim(), 5,
    "A phone number is a standard expectation, even if email is your preferred contact.");
  check("has-title", "Target title/headline present", !!data.personalInfo.title.trim(), 5,
    "A clear title under your name helps both ATS parsing and a human skimming the top of the page.");
  check("has-summary", "Summary section filled in", data.summary.trim().length > 40, 10,
    "A 2-3 sentence summary gives an ATS keyword-matcher and a recruiter's first skim something to work with.");
  check("has-experience", "At least one work experience entry", data.experience.length > 0, 20,
    "Experience is the section ATS platforms weight most heavily.");

  const bulletedEntries = data.experience.filter((e) => bulletCount(e.description) >= 2).length;
  check("experience-bullets", "Experience entries use bullet points", data.experience.length === 0 ? false : bulletedEntries === data.experience.length, 15,
    "Bulleted achievements (start a line with \"- \") parse more reliably than one dense paragraph, and are easier for a recruiter to scan.");

  const allExperienceText = data.experience.map((e) => e.description).join(" ").toLowerCase();
  const hasActionVerb = ACTION_VERBS.some((v) => allExperienceText.includes(v));
  check("action-verbs", "Experience bullets start with strong action verbs", data.experience.length === 0 ? false : hasActionVerb, 10,
    "Lead bullets with verbs like \"led,\" \"built,\" \"reduced\" rather than \"responsible for.\"");

  check("has-education", "At least one education entry", data.education.length > 0, 10,
    "Even a self-taught or in-progress entry helps an ATS's education-field parser, which often expects something here.");

  check("has-skills", "Skills list filled in", data.skills.length >= 3, 10,
    "A dedicated skills list is what most ATS keyword-matching actually scans first.");

  const wordCount = tokenize(
    [data.summary, ...data.experience.map((e) => e.description), ...data.projects.map((p) => p.description)].join(" ")
  ).length;
  check("reasonable-length", "Reasonable content length (not too thin, not a wall of text)", wordCount >= 60 && wordCount <= 900, 5,
    wordCount < 60 ? "This reads as quite thin for an ATS to extract much from — add more detail to your experience bullets." : "Long-form content can get truncated or de-prioritized by some ATS parsers — consider trimming to the most relevant points.");

  let keywordMatch: AtsResult["keywordMatch"] = null;
  if (jobDescription && jobDescription.trim().length > 20) {
    const jdWords = new Set(tokenize(jobDescription));
    const resumeWords = new Set(
      tokenize([data.summary, data.skills.join(" "), ...data.experience.map((e) => e.description)].join(" "))
    );
    const jdList = Array.from(jdWords);
    const matched = jdList.filter((w) => resumeWords.has(w));
    const missing = jdList.filter((w) => !resumeWords.has(w)).slice(0, 20);
    const percent = jdList.length > 0 ? Math.round((matched.length / jdList.length) * 100) : 0;
    keywordMatch = { matched, missing, percent };
  }

  return { score: total === 0 ? 0 : Math.round((earned / total) * 100), findings, keywordMatch };
}
