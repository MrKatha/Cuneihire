"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import { ModernTemplate } from "@/lib/resumeTemplates/ModernTemplate";
import { ClassicTemplate } from "@/lib/resumeTemplates/ClassicTemplate";
import { uploadAttachment } from "@/lib/storage";
import { computePageBreaks, mmToPx } from "@/lib/resumePaginate";
import { defaultResumeStyle } from "@/lib/types";
import type { Attachment, ResumeData, ResumeProfile, ResumeTemplateId } from "@/lib/types";

const TEMPLATES: Record<ResumeTemplateId, (props: { data: ResumeData }) => React.JSX.Element> = {
  modern: ModernTemplate,
  classic: ClassicTemplate,
};

// What "Preview as PDF"'s Download button needs (2026-08-25, third same-day follow-up — operator ask: "the
// page breaks are messed up again... have some inspiration from the normal resume builder page preview...
// present the PDF as it is presenting it in the resume builder, just bigger"). Two earlier passes tried to
// preview the *generated PDF itself* — first via an <iframe> (brought Chrome's own PDF.js chrome along:
// thumbnail sidebar, zoom controls), then via slicing the PDF's own source image with CSS (technically
// pixel-faithful to the real file, but a second, independent measurement/render path from
// ResumeBuilder.tsx's own live preview, and it visibly disagreed on where pages actually break). This pass
// drops PDF rendering from the preview entirely: PdfPreviewModal.tsx now mounts the exact same
// `data`/`templateId` through the exact same template component and the exact same computePageBreaks() +
// page-window technique ResumeBuilder.tsx's own live preview uses (see that file's renderFormAndPreview) —
// so page breaks are *guaranteed* identical to what's already on screen, not just usually-matching, and
// opening the preview no longer needs to wait on a render at all. The real PDF is only ever generated
// lazily, when Download is actually clicked inside the modal — this is all that step still needs.
export type ResumePdfDownload = { url: string; fileName: string };

// Generates a PDF snapshot Attachment from a saved ResumeProfile (2026-08-19) — shared by a template's
// "Use the Cuneihire Resume Builder" resume slot (RoleTemplates.tsx) and the Global Resume & Files panel
// (the repurposed ResumesTab.tsx). See docs/architecture.md's "Email Templates redesign" section.
//
// Mirrors the html2canvas+jsPDF pipeline already proven in the old ResumeBuilder.tsx handleSaveToLibrary,
// just rendering off-screen instead of from a live-mounted preview — neither consumer here has one
// mounted. html2canvas needs real layout to measure, so the host is moved off-screen
// (position: absolute, far left) rather than hidden (visibility/display: none would give it zero size).
//
// Explicit, user-triggered generation only — this hook never re-runs on its own when the source
// ResumeProfile changes later (same "snapshot, not live FK" precedent used everywhere else in this app).
// A consumer renders `portal` once anywhere in its tree and calls `generate(profile, userId)` from a
// button handler; `busy` reflects whether a generation is currently in flight (only one at a time).
export function useResumeProfilePdf() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Unpadded content mount — padding is applied entirely synthetically at draw time below (2026-08-20,
  // real four-sided-padding fix), never baked into this element's own CSS, so there's nothing here for
  // computePageBreaks to correct for; it measures this node directly.
  const hostRef = useRef<HTMLDivElement>(null);
  const [rendering, setRendering] = useState<ResumeProfile | null>(null);
  const busyRef = useRef(false);

  // Shared core (2026-08-25, split out for "Preview as PDF" — see ResumePdfDownload's doc comment above for
  // the current shape of that feature). Runs the exact same off-screen html2canvas+jsPDF pipeline
  // `generate()` always has and resolves the raw `Blob` — used both for `generate()`'s upload and for the
  // preview modal's on-demand Download.
  const renderToBlob = useCallback((profile: ResumeProfile): Promise<Blob> => {
    if (busyRef.current) {
      return Promise.reject(new Error("Already generating a PDF — wait for it to finish."));
    }
    busyRef.current = true;
    return new Promise<Blob>((resolve, reject) => {
      setRendering(profile);
      // Two animation frames: one for React to commit the off-screen render, one more so layout/paint
      // settles before html2canvas measures the node.
      requestAnimationFrame(() => {
        requestAnimationFrame(async () => {
          try {
            const node = hostRef.current;
            if (!node) throw new Error("Resume render host not mounted.");

            const canvas = await html2canvas(node, { scale: 2, backgroundColor: "#ffffff" });
            const pdf = new jsPDF({ unit: "mm", format: "a4" });
            // JPEG, not PNG (2026-08-24, bug fix alongside the render-width fix above — "don't stop until
            // done"): jsPDF does dedupe this single image across every addPage() call (confirmed by
            // inspecting a generated PDF's actual object table — one shared image XObject, not one per
            // page), but a several-page resume's full-height canvas as *lossless* PNG still produced a
            // ~27MB file on its own — comfortably over Gmail's 25MB attachment cap, i.e. this app's own
            // "AI-automated job applications" core purpose could silently fail to send. A resume is flat
            // white space and crisp text/rules, not photographic detail, so JPEG's lossy compression at a
            // high quality factor costs no visible sharpness here while cutting the embedded image to a
            // small fraction of the PNG's size — background is already forced opaque white above, so JPEG's
            // lack of an alpha channel loses nothing.
            const imgData = canvas.toDataURL("image/jpeg", 0.92);
            const pageWidthMm = pdf.internal.pageSize.getWidth();
            const pageHeightMm = pdf.internal.pageSize.getHeight();

            // Real padding on all four sides, applied synthetically at draw time (2026-08-20, operator ask
            // — "the padding should be applied from the top and bottom side of the page as well," not just
            // left/right). `node` carries no CSS padding of its own (see the ref comment above), so the
            // captured image is pure content; padding-left/right come from scaling the image to
            // `contentWidthMm` instead of the full page width and drawing it inset by `pagePaddingMm`, and
            // padding-top/bottom come from the y-offset math and the two masks below — the same margin on
            // *every* page, not just a one-time margin at the very start/end of the document (which is all
            // baking padding into the source image once could ever give, since a page break is just a
            // Y-offset into one continuous image, not a real page boundary in the source).
            const pagePaddingMm = profile.data.style?.pagePaddingMm ?? defaultResumeStyle().pagePaddingMm;
            const contentWidthMm = Math.max(pageWidthMm - 2 * pagePaddingMm, 1);
            const imgHeightMm = (canvas.height * contentWidthMm) / canvas.width;

            // Content-aware pagination (2026-08-20, bug fix) — addImage() has no built-in pagination, so
            // a resume longer than one A4 page gets sliced across as many pages as it takes; the old
            // version sliced at blind fixed-height offsets, which could cut an experience entry in half.
            // computePageBreaks measures `node` (still mounted, right after html2canvas captured it) and
            // only ever breaks at a [data-page-atom] boundary (now one per *line*, not per whole entry —
            // see lib/resumeTemplates/ModernTemplate.tsx's header comment). Needs the page's own padding to
            // get the per-page capacity right — see lib/resumePaginate.ts's header comment.
            //
            // paddingPx must be in *this render's own* px-space, not mmToPx()'s generic 96dpi one
            // (2026-08-24, bug fix — "the pdf is still messed up... a little upper" — real content getting
            // cut off at the bottom of every page in the actual generated PDF, invisible because it fell
            // past the PDF page boundary; the live preview never showed this since it's a different, already
            // dimensionally-consistent code path — see ResumeBuilder.tsx's own measure()). `node` is an
            // arbitrary off-screen render at a fixed CSS `width:"800px"` (chosen purely for html2canvas
            // sharpness) that represents `contentWidthMm` of real page width — i.e. its actual scale is
            // node.offsetWidth px per contentWidthMm mm (~4.44 px/mm at the defaults), NOT the standard
            // 96dpi/25.4 ≈ 3.78 px/mm mmToPx() assumes. Feeding computePageBreaks a 96dpi-scaled padding
            // value while its content width is measured in this render's *different* scale silently mixed
            // two incompatible units — outerWidthPx (content width + padding) came out ~17% too large,
            // which (run through the A4 aspect ratio) made pageHeightPx ~17% too generous, so
            // computePageBreaks fit noticeably more content onto each page than the real, correctly-scaled
            // A4 page drawn below can actually hold. mmPerDomPx (already computed further down, just moved
            // up here) *is* this render's real mm-per-px ratio — dividing pagePaddingMm by it gives padding
            // in the same px-space computePageBreaks is measuring `node` in, matching exactly what
            // ResumeBuilder.tsx's mmToPx(pagePaddingMm) achieves for *its* own container, which — unlike
            // this one — genuinely is laid out in real CSS mm, so the generic 96dpi conversion happens to be
            // correct there.
            const mmPerDomPx = imgHeightMm / node.getBoundingClientRect().height;
            const paddingPx = pagePaddingMm / mmPerDomPx;
            // BOTTOM_SAFETY_MM (2026-08-24, bug fix, paired with the mask below) — reserves a small,
            // guaranteed-blank slice at the bottom of every "full" page so the bottom mask has real room to
            // work with; see computePageBreaks's `safetySlackPx` doc comment for the full reasoning.
            const BOTTOM_SAFETY_MM = 1.5;
            const { breaks: domBreaks } = computePageBreaks(node, paddingPx, BOTTOM_SAFETY_MM / mmPerDomPx);
            let startPx = 0;
            domBreaks.forEach((endPx, idx) => {
              if (idx > 0) pdf.addPage();
              // Image-row `startPx` lands at page-y = pagePaddingMm on every page (not just the first) —
              // see the padding comment above.
              const drawY = pagePaddingMm - startPx * mmPerDomPx;
              pdf.addImage(imgData, "JPEG", pagePaddingMm, drawY, contentWidthMm, imgHeightMm);
              // Mask both margins in one pass (2026-08-20). Top: every page after the first draws the
              // image at a large negative Y to reveal its own slice, which means the *previous* page's
              // tail would otherwise bleed into this page's top-margin band — the mirror of the bottom
              // case. Bottom: covers both the deliberate bottom margin and any early-ending slack
              // (computePageBreaks can end a page short of a full page when the next atom doesn't fit in
              // the remainder). jsPDF's own `.clip()` was tried in place of these masks (true geometric
              // clipping instead of painting over) and rejected — with a clip region active, `addImage`
              // stopped painting *anything* on the page in this jsPDF version, a worse regression than
              // either masking issue below.
              //
              // TOP_GUARD_MM / BOTTOM_GUARD_MM (2026-08-24, bug fix — "the pdf is still messed up,"
              // confirmed via a high-DPI render: the previous page's last line was still faintly visible at
              // the very top of the next page). Every break lands exactly on a real atom boundary, so in
              // principle each mask's edge should align with zero bleed — in practice `startPx`/`endPx`
              // pass through several independent unit conversions before becoming a mask's mm coordinate
              // (native DOM px → this render's own mmPerDomPx → jsPDF's internal mm handling), each its own
              // rounding opportunity, and the accumulated drift was enough to peek through on both edges of
              // a page (confirmed independently at the top *and*, more subtly, the bottom).
              //
              // The two margins aren't symmetric to guard, though. The top margin band is *always*
              // genuinely blank by construction, so extending that mask further down only ever eats into
              // guaranteed-empty space — safe at any reasonable size. The bottom mask's boundary is defined
              // by where the *last included atom itself* ends, so pulling it earlier by a fixed amount used
              // to reach directly into that atom's own box on a tightly-packed page (confirmed: a page whose
              // last line landed right at the break lost the bottom third of that line's own text to a 2mm
              // guard — the same size as the top's, which is fine there). Fixed at the source instead of
              // papered over here: `computePageBreaks` above is now asked for pages a little short of their
              // true capacity (`BOTTOM_SAFETY_MM` — see its own doc comment), so a "full" page always has at
              // least that much genuine blank room below its last atom before the page's true edge. This
              // guard is kept safely smaller than that reserved slack, so — unlike the earlier attempt — it
              // can never reach into real content, only into blank space `computePageBreaks` already
              // guaranteed would be there.
              //
              // Except on the *last* page of the whole document (2026-08-24, bug fix — found immediately
              // after the fix above, on the actual last certification: same symptom, one page later).
              // `BOTTOM_SAFETY_MM` only guarantees slack when computePageBreaks actually excludes a
              // following atom to enforce it — proof that trimming its capacity did something. On the final
              // page there *is* no following atom: its last included atom's bottom is simply the document's
              // own natural end, with no "next atom got pushed off" step to have created any reserved room
              // after it. Guarding it the same amount as every other page silently re-created the exact bug
              // being fixed, just one atom later (this time on "Google Prompting Essentials," the resume's
              // actual last line). It also needs no guard on its own merits: with nothing left in the source
              // image past this point, there's no next-page content that could ever bleed up into it.
              const isLastPage = idx === domBreaks.length - 1;
              const TOP_GUARD_MM = 2;
              const BOTTOM_GUARD_MM = isLastPage ? 0 : 1;
              pdf.setFillColor(255, 255, 255);
              pdf.rect(0, 0, pageWidthMm, pagePaddingMm + TOP_GUARD_MM, "F");
              const usedHeightMm = (endPx - startPx) * mmPerDomPx;
              const contentBottomMm = pagePaddingMm + usedHeightMm - BOTTOM_GUARD_MM;
              if (contentBottomMm < pageHeightMm - 0.01) {
                pdf.rect(0, contentBottomMm, pageWidthMm, pageHeightMm - contentBottomMm, "F");
              }
              startPx = endPx;
            });

            resolve(pdf.output("blob"));
          } catch (err) {
            reject(err instanceof Error ? err : new Error("Failed to generate PDF."));
          } finally {
            busyRef.current = false;
            setRendering(null);
          }
        });
      });
    });
  }, []);

  // Preserve the human-readable label as-is (2026-08-20, bug fix) — this used to slug-sanitize it
  // (spaces/punctuation → hyphens), silently turning "Muhammad Sohaib Amin — AI Automation" into
  // "muhammad-sohaib-amin-ai-automation.pdf" everywhere it's shown or emailed. Pointless for the uploaded
  // case: uploadAttachment() writes to a fully randomized storage path, never file.name, so there was never
  // a storage-safety reason to mangle it — only strip characters that would actually be unsafe in a
  // filename (path separators), and avoid a double ".pdf". Shared with the preview path below so the
  // pop-up's title/download name matches what Save/Download would actually produce.
  function pdfFileName(profile: ResumeProfile): string {
    const cleanLabel = (profile.label || "resume").trim().replace(/[\\/:*?"<>|]+/g, "-");
    return /\.pdf$/i.test(cleanLabel) ? cleanLabel : `${cleanLabel}.pdf`;
  }

  const generate = useCallback(
    async (profile: ResumeProfile, userId: string): Promise<Attachment> => {
      const blob = await renderToBlob(profile);
      const file = new File([blob], pdfFileName(profile), { type: "application/pdf" });
      return uploadAttachment(file, userId);
    },
    [renderToBlob]
  );

  // The preview modal's on-demand Download (2026-08-25) — same render, no upload. Called lazily, only when
  // Download is actually clicked inside PdfPreviewModal.tsx (see ResumePdfDownload's doc comment above) —
  // the caller owns the returned blob: URL's lifetime; this hook has no "did the download finish" signal of
  // its own to revoke it, so the modal triggers the browser's save dialog immediately and lets it go.
  const generateDownload = useCallback(
    async (profile: ResumeProfile): Promise<ResumePdfDownload> => {
      const blob = await renderToBlob(profile);
      return { url: URL.createObjectURL(blob), fileName: pdfFileName(profile) };
    },
    [renderToBlob]
  );

  const Template = rendering ? TEMPLATES[rendering.templateId] : null;

  // Render width must equal the *real* content width, in true 96dpi-mm px (2026-08-24, bug fix — "the pdf
  // is still messed up... don't stop until done"). Used to be a flat "800px" — arbitrary, chosen only for
  // html2canvas sharpness, with no relationship to the ~180mm (at the default 15mm padding) the image is
  // later scaled down to on the actual page. Since font sizes are absolute (pt), rendering at a wider column
  // than the real page's content area lets more words fit per line before wrapping than the live preview
  // (which genuinely lays out at this real width) ever shows — fewer, longer lines, so the whole document
  // measures shorter, less total height, than it should. Scaled back down to the true content width for the
  // PDF, that under-wrapped text reads *smaller* than its nominal pt size and paginates into noticeably
  // fewer pages than the live preview promised (confirmed: 3 pages generated here vs 5 shown on screen for
  // the same resume) — a real fidelity bug, not just cosmetic, since the PDF is the thing that actually gets
  // emailed. `mmToPx` at A4's 210mm, minus this resume's own padding, matches exactly how
  // ResumeBuilder.tsx's live preview sizes `previewContentRef`, so line-wrapping (and therefore effective
  // font size and page count) now matches what the candidate actually designed. `scale: 2` in
  // html2canvas below still supersamples this for a sharp image — no separate "make it bigger for quality"
  // width hack needed.
  const renderPaddingMm = rendering?.data.style?.pagePaddingMm ?? defaultResumeStyle().pagePaddingMm;
  const renderWidthPx = Math.round(mmToPx(210 - 2 * renderPaddingMm));

  const portal =
    mounted && typeof document !== "undefined"
      ? createPortal(
          <div
            style={{ position: "absolute", left: "-9999px", top: 0, width: `${renderWidthPx}px`, pointerEvents: "none" }}
            aria-hidden="true"
          >
            {/* No padding here (2026-08-20) — it's applied entirely synthetically in generate() so every
                page gets the same four-sided margin, not just a one-time margin at the very start/end of
                the document. See the ref comment above and generate()'s padding comment. */}
            <div ref={hostRef} style={{ background: "#fff" }}>
              {Template && rendering && <Template data={rendering.data} />}
            </div>
          </div>,
          document.body
        )
      : null;

  return { generate, generateDownload, portal, busy: rendering !== null };
}
