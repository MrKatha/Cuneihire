import type {
  CandidateProfile,
  ProfileSkill,
  ResumeCertification,
  ResumeData,
  ResumeEducation,
  ResumeExperience,
  ResumeProject,
  RoleDef,
} from "@/lib/types";
import { composeResumeData } from "@/lib/resumeCompose";

// Resume Builder redesign (2026-08-20) — "from your profile" mode lets a candidate edit a resume that
// started as a straight composition of their profile, then choose whether those edits flow back upstream.
// This file is the pure diff/merge pair behind that choice — no I/O, mirrors lib/resumeCompose.ts's style
// (and is verified the same way: no ts-node/tsx runtime here, so checked by build/typecheck + manual
// tracing rather than direct-call tests).

export type ResumeSyncDiff = {
  newExperience: ResumeExperience[];
  changedExperience: ResumeExperience[];
  newEducation: ResumeEducation[];
  changedEducation: ResumeEducation[];
  newProjects: ResumeProject[];
  changedProjects: ResumeProject[];
  newCertifications: ResumeCertification[];
  changedCertifications: ResumeCertification[];
  newSkillNames: string[];
  summaryChanged: boolean;
  identityChanged: boolean; // any of name/email/phone/address/portfolioUrl
  hasChanges: boolean;
};

// Simple, safe for these shapes: every field is a primitive (string/boolean), no nesting — so comparing
// everything but `id` via JSON.stringify is equivalent to a real field-by-field diff without the
// keyof-generics ceremony.
function withoutId<T extends { id: string }>(item: T): Omit<T, "id"> {
  const rest: Record<string, unknown> = { ...item };
  delete rest.id;
  return rest as Omit<T, "id">;
}
function itemChanged<T extends { id: string }>(a: T, b: T): boolean {
  return JSON.stringify(withoutId(a)) !== JSON.stringify(withoutId(b));
}

function diffList<T extends { id: string }>(profileItems: T[], draftItems: T[]): { added: T[]; changed: T[] } {
  const byId = new Map(profileItems.map((i) => [i.id, i]));
  const added: T[] = [];
  const changed: T[] = [];
  for (const item of draftItems) {
    const existing = byId.get(item.id);
    if (!existing) added.push(item);
    else if (itemChanged(existing, item)) changed.push(item);
  }
  return { added, changed };
}

// Compares a role's live draft against what composeResumeData would produce RIGHT NOW from the current
// profile/roleDef (never a stale snapshot from when editing started — the profile/role selection may have
// changed elsewhere meanwhile). Deliberately only DETECTS differences in the "the draft has something the
// profile doesn't, or edited something the profile has" direction — an item present in the profile but
// missing from the draft is never reported (it just isn't part of this particular resume, not a change to
// sync); see mergeResumeIntoProfile below, which is additive/edit-in-place only for the same reason.
export function diffResumeAgainstProfile(profile: CandidateProfile, roleDef: RoleDef, draft: ResumeData): ResumeSyncDiff {
  const baseline = composeResumeData(profile, roleDef);

  const exp = diffList(profile.experience, draft.experience);
  const edu = diffList(profile.education, draft.education);
  const proj = diffList(profile.projects, draft.projects);
  const cert = diffList(profile.certifications, draft.certifications);

  const existingSkillNamesLower = new Set(profile.skills.map((s) => s.name.trim().toLowerCase()));
  const seenLower = new Set<string>();
  const newSkillNames: string[] = [];
  for (const name of draft.skills) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (existingSkillNamesLower.has(lower) || seenLower.has(lower)) continue;
    seenLower.add(lower);
    newSkillNames.push(trimmed);
  }

  const summaryChanged = draft.summary.trim() !== (baseline.summary || "").trim();
  const identityChanged =
    draft.personalInfo.fullName.trim() !== profile.name.trim() ||
    draft.personalInfo.email.trim() !== profile.email.trim() ||
    draft.personalInfo.phone.trim() !== profile.phone.trim() ||
    draft.personalInfo.location.trim() !== profile.address.trim() ||
    draft.personalInfo.portfolioUrl.trim() !== profile.portfolioUrl.trim();

  const hasChanges =
    exp.added.length > 0 || exp.changed.length > 0 ||
    edu.added.length > 0 || edu.changed.length > 0 ||
    proj.added.length > 0 || proj.changed.length > 0 ||
    cert.added.length > 0 || cert.changed.length > 0 ||
    newSkillNames.length > 0 || summaryChanged || identityChanged;

  return {
    newExperience: exp.added,
    changedExperience: exp.changed,
    newEducation: edu.added,
    changedEducation: edu.changed,
    newProjects: proj.added,
    changedProjects: proj.changed,
    newCertifications: cert.added,
    changedCertifications: cert.changed,
    newSkillNames,
    summaryChanged,
    identityChanged,
    hasChanges,
  };
}

// Applies a diff onto the shared profile + this role's own selection ("Save to Profile & Role"). Purely
// additive/edit-in-place: new items are appended and selected for this role, an existing item that was
// edited is overwritten by id — but nothing is ever REMOVED from the profile or a role's selectedXIds,
// even if the draft dropped something the profile has. Same "forgiving default, never destroy shared data
// from a per-view action" precedent as everywhere else in this app. Caller applies the two return values
// via onProfileChange/onUpdateRoleRules.
export function mergeResumeIntoProfile(
  profile: CandidateProfile,
  roleDef: RoleDef,
  draft: ResumeData
): { profile: CandidateProfile; roleDefPatch: Partial<RoleDef> } {
  const diff = diffResumeAgainstProfile(profile, roleDef, draft);

  function applyList<T extends { id: string }>(items: T[], added: T[], changed: T[]): T[] {
    const changedById = new Map(changed.map((i) => [i.id, i]));
    return [...items.map((i) => changedById.get(i.id) || i), ...added];
  }

  const nextExperience = applyList(profile.experience, diff.newExperience, diff.changedExperience);
  const nextEducation = applyList(profile.education, diff.newEducation, diff.changedEducation);
  const nextProjects = applyList(profile.projects, diff.newProjects, diff.changedProjects);
  const nextCertifications = applyList(profile.certifications, diff.newCertifications, diff.changedCertifications);

  const newSkills: ProfileSkill[] = diff.newSkillNames.map((name) => ({ id: crypto.randomUUID(), name }));
  const nextSkills = [...profile.skills, ...newSkills];

  const nextProfile: CandidateProfile = {
    ...profile,
    experience: nextExperience,
    education: nextEducation,
    projects: nextProjects,
    certifications: nextCertifications,
    skills: nextSkills,
    // Not selectable per-role — always carried through whole (see RoleDef's comment in types.ts) — so a
    // sync just overwrites the profile's copy wholesale rather than diffing item by item.
    languages: draft.languages,
    bio: diff.summaryChanged ? draft.summary : profile.bio,
    name: draft.personalInfo.fullName.trim() || profile.name,
    email: draft.personalInfo.email.trim() || profile.email,
    phone: draft.personalInfo.phone.trim() || profile.phone,
    address: draft.personalInfo.location.trim() || profile.address,
    portfolioUrl: draft.personalInfo.portfolioUrl.trim() || profile.portfolioUrl,
  };

  const roleDefPatch: Partial<RoleDef> = {
    selectedExperienceIds: Array.from(new Set([...roleDef.selectedExperienceIds, ...diff.newExperience.map((e) => e.id)])),
    selectedEducationIds: Array.from(new Set([...roleDef.selectedEducationIds, ...diff.newEducation.map((e) => e.id)])),
    selectedProjectIds: Array.from(new Set([...roleDef.selectedProjectIds, ...diff.newProjects.map((p) => p.id)])),
    selectedCertificationIds: Array.from(new Set([...roleDef.selectedCertificationIds, ...diff.newCertifications.map((c) => c.id)])),
    selectedSkillIds: Array.from(new Set([...roleDef.selectedSkillIds, ...newSkills.map((s) => s.id)])),
  };

  return { profile: nextProfile, roleDefPatch };
}
