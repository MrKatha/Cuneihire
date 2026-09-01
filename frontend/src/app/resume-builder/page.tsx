import type { Metadata } from "next";
import { PublicResumeBuilder } from "@/components/PublicResumeBuilder";

// Public, unauthenticated, ad-monetized/lead-gen resume builder (2026-08-31) -- see
// docs/architecture.md's "Public resume builder" section. Real metadata (unlike the authed app's generic
// tags) since organic search ("resume builder") is this page's actual primary channel, per the operator's
// own plan -- not a link from inside the product.
export const metadata: Metadata = {
  title: "Free Resume Builder — ATS-Friendly, No Sign-Up Required | Cuneihire",
  description:
    "Build a clean, ATS-friendly resume for free — no account needed. Live ATS-friendliness score, keyword match against a job description, instant PDF download.",
  keywords: ["resume builder", "free resume builder", "ats resume", "ats friendly resume", "resume maker", "cv builder"],
};

export default function ResumeBuilderPage() {
  return <PublicResumeBuilder initialMode="choose" />;
}
