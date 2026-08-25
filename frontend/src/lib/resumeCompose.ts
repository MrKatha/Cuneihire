import { emptyResumeData, type CandidateProfile, type JobPosting, type ResumeData, type RoleDef } from "@/lib/types";

// Turns the candidate's one permanent profile into the resume a specific role's module selection
// dedicates to it (2026-08-19). Pure, no I/O, no AI — the selection was already made when the role was
// configured, so assembly is just filtering. Used both client-side (Resume Builder's "New from role",
// Job Board's Easy Apply) and could be reused server-side later since it takes plain data in and out.
// Unmatched ids (a selected item that was since deleted from the profile) drop silently — same
// "unknown isn't a fail" tolerance as everywhere else this app degrades gracefully rather than erroring.
export function composeResumeData(profile: CandidateProfile, roleDef: RoleDef): ResumeData {
  const base = emptyResumeData();
  const experienceIds = new Set(roleDef.selectedExperienceIds);
  const educationIds = new Set(roleDef.selectedEducationIds);
  const projectIds = new Set(roleDef.selectedProjectIds);
  const certificationIds = new Set(roleDef.selectedCertificationIds);
  const skillIds = new Set(roleDef.selectedSkillIds);

  return {
    ...base,
    personalInfo: {
      ...base.personalInfo,
      fullName: profile.name,
      title: roleDef.label,
      email: profile.email,
      phone: profile.phone,
      location: profile.address,
      portfolioUrl: profile.portfolioUrl,
    },
    summary: profile.bio,
    experience: profile.experience.filter((e) => experienceIds.has(e.id)),
    education: profile.education.filter((e) => educationIds.has(e.id)),
    projects: profile.projects.filter((p) => projectIds.has(p.id)),
    certifications: profile.certifications.filter((c) => certificationIds.has(c.id)),
    skills: profile.skills.filter((s) => skillIds.has(s.id)).map((s) => s.name),
    // Not selectable per-role — always carried through whole (see RoleDef's comment in types.ts).
    languages: profile.languages,
  };
}

// Picks which of the candidate's roles a job posting is for, no AI call — the operator's own framing is
// that most candidates target exactly one role, so that's the fast path; with more than one, score each
// role's keywords against the posting's title+description (case-insensitive substring hits) and take the
// highest. Every role still scoring 0 falls back to the first role rather than returning null — a rough
// guess the candidate can override beats blocking Easy Apply outright. Returns null only when the
// candidate has no roles at all yet.
export function matchRoleToPosting(
  roleDefs: RoleDef[],
  posting: Pick<JobPosting, "title" | "description">
): RoleDef | null {
  if (roleDefs.length === 0) return null;
  if (roleDefs.length === 1) return roleDefs[0];

  const haystack = `${posting.title} ${posting.description}`.toLowerCase();
  let best = roleDefs[0];
  let bestScore = -1;
  for (const def of roleDefs) {
    const score = def.keywords.reduce((sum, kw) => {
      const needle = kw.trim().toLowerCase();
      if (!needle) return sum;
      return sum + (haystack.includes(needle) ? 1 : 0);
    }, 0);
    if (score > bestScore) {
      best = def;
      bestScore = score;
    }
  }
  return best;
}
