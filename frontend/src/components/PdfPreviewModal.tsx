"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { ModernTemplate } from "@/lib/resumeTemplates/ModernTemplate";
import { ClassicTemplate } from "@/lib/resumeTemplates/ClassicTemplate";
import { defaultResumeStyle } from "@/lib/types";
import type { ResumeData, ResumeTemplateId } from "@/lib/types";
import type { ResumePdfDownload } from "@/lib/resumePdf";

const TEMPLATES: Record<ResumeTemplateId, (props: { data: ResumeData }) => React.JSX.Element> = {
  modern: ModernTemplate,
  classic: ClassicTemplate,
};

type Props = {
  data: ResumeData;
  templateId: ResumeTemplateId;
  fileName: string;
  // The live editor's own already-computed break points (2026-08-25, bug fix — see the header comment
  // below), reused as-is rather than re-measured here.
  pageBreaks: number[];
  onRequestDownload: () => Promise<ResumePdfDownload>;
  onClose: () => void;
};

// A big preview with the *same* page breaks as the live editor (2026-08-25, third same-day follow-up —
// operator ask: "the page breaks are messed up again... have some inspiration from the normal resume
// builder page preview... present the PDF as it is presenting it in the resume builder, just bigger"). Two
// earlier passes rendered the actual generated PDF (first via <iframe>, then by slicing its source image
// with CSS) — both are a *second, independent* measurement/render path from ResumeBuilder.tsx's own live
// preview, and the image-slicing one visibly disagreed with it on where pages break.
//
// This version mounts the same `data` through the same template component and the same page-window
// technique ResumeBuilder.tsx's renderFormAndPreview already uses (fixed-size A4 window, padding as spacer
// divs either side of a clipped, translateY-shifted content block, fit-to-available-space via `zoom`) — but
// deliberately does NOT run its own computePageBreaks() pass. A first attempt did re-measure independently
// and *still* disagreed with the live editor — traced to a real, if subtle, quirk: computePageBreaks
// self-corrects for whatever `zoom` is active on its ancestor at measurement time (see
// lib/resumePaginate.ts's own header comment on this), which recovers the right *scale factor*, but the
// browser's actual sub-pixel text/glyph snapping still differs slightly between two genuinely different
// zoom levels (the live editor's small in-form fitScale vs. this modal's own much-bigger one) — confirmed
// directly: nearly every one of a resume's ~97 measured atoms landed 1-4px apart between the two contexts,
// small on any one line but enough, compounded across a whole document, to tip the total page count from 5
// to 4. Reusing the live editor's *already-computed* `pageBreaks` prop sidesteps the whole issue — there's
// only ever one measurement, taken once, at one zoom level, so there's nothing left to disagree with.
//
// Deliberately does NOT reuse ResumeBuilder.tsx's own `.resume-print-area`/`.resume-print-clip`/
// `.resume-print-content` classes, even though the structure mirrors them — those are targeted by name in
// globals.css's `@media print` block (toggles visibility for `window.print()`'s "capture this exact
// element" trick); sharing them here would make this modal's own copy show up too if a print happened to
// fire while it's open. Fresh, unclaimed class names below avoid that collision entirely; this preview
// itself is also wrapped in `no-print` so it simply isn't part of the page at all during a real print.
export function PdfPreviewModal({ data, templateId, fileName, pageBreaks, onRequestDownload, onClose }: Props) {
  const Template = TEMPLATES[templateId];
  const style = data.style ?? defaultResumeStyle();
  const contentRef = useRef<HTMLDivElement>(null);
  const [currentPage, setCurrentPage] = useState(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Fit-to-available-space scale — same `zoom`-based approach as ResumeBuilder.tsx's own fitScale, just
  // fitting a much bigger box (this modal's own body) instead of the small in-form preview pane.
  const viewportRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [fitScale, setFitScale] = useState(1);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const page = pageRef.current;
    if (!viewport || !page) return;
    function recompute() {
      if (!viewport || !page || !page.offsetWidth || !page.offsetHeight) return;
      const scale = Math.min(viewport.clientWidth / page.offsetWidth, viewport.clientHeight / page.offsetHeight, 1);
      setFitScale((prev) => (Math.abs(prev - scale) < 0.001 ? prev : scale));
    }
    recompute();
    const raf = requestAnimationFrame(recompute);
    const ro = new ResizeObserver(recompute);
    ro.observe(viewport);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const [downloading, setDownloading] = useState(false);
  async function handleDownload() {
    setDownloading(true);
    try {
      const { url, fileName: name } = await onRequestDownload();
      // Trigger the browser's save immediately via a synthetic click, same as any plain download link —
      // avoids a second "now click here to actually get it" step once generation finishes.
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } catch (e: any) {
      toast.error(e?.message || "Failed to generate the PDF.");
    } finally {
      setDownloading(false);
    }
  }

  const pageCount = Math.max(pageBreaks.length, 1);
  const startPx = currentPage > 0 ? (pageBreaks[currentPage - 1] ?? 0) : 0;
  const endPx = pageBreaks[currentPage] ?? startPx;
  const thisPageContentPx = Math.max(endPx - startPx, 0);

  return (
    <div className="modal-backdrop no-print" role="presentation" onClick={onClose}>
      <div
        className="modal-card preview-modal pdf-preview-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pdf-preview-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <div>
            <h2 id="pdf-preview-title">{fileName}</h2>
            <p className="hint compact">Page {currentPage + 1} of {pageCount} — same page breaks as the editor.</p>
          </div>
          <div className="preview-actions">
            <button type="button" className="btn" disabled={downloading} onClick={handleDownload}>
              {downloading ? "Preparing…" : "Download"}
            </button>
            <button type="button" className="btn ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        {pageCount > 1 && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "0.6rem", marginBottom: "0.6rem" }}>
            <button type="button" className="btn ghost" style={{ padding: "0.15rem 0.55rem" }} disabled={currentPage === 0} onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}>
              ‹
            </button>
            <span className="hint compact" style={{ margin: 0 }}>
              Page {currentPage + 1} of {pageCount}
            </span>
            <button type="button" className="btn ghost" style={{ padding: "0.15rem 0.55rem" }} disabled={currentPage >= pageCount - 1} onClick={() => setCurrentPage((p) => Math.min(pageCount - 1, p + 1))}>
              ›
            </button>
          </div>
        )}

        <div ref={viewportRef} className="pdf-preview-stack">
          {/* Same page-window structure as ResumeBuilder.tsx's own live preview — fixed A4 size,
              overflow:hidden, shrunk to fit via `zoom`; padding as spacer divs either side of the clipped,
              translateY-shifted content so nothing can bleed into the margins. Fresh class names (see the
              header comment) instead of ResumeBuilder.tsx's `.resume-print-*` ones. */}
          <div
            ref={pageRef}
            className="pdf-preview-page-frame"
            style={{ width: "210mm", height: "297mm", zoom: fitScale } as React.CSSProperties}
          >
            <div style={{ height: `${style.pagePaddingMm}mm`, flexShrink: 0 }} />
            <div className="pdf-preview-page-clip" style={{ paddingLeft: `${style.pagePaddingMm}mm`, paddingRight: `${style.pagePaddingMm}mm` }}>
              <div style={{ height: `${thisPageContentPx}px`, overflow: "hidden" }}>
                <div ref={contentRef} style={{ transform: `translateY(-${startPx}px)` }}>
                  <Template data={data} />
                </div>
              </div>
            </div>
            <div style={{ height: `${style.pagePaddingMm}mm`, flexShrink: 0 }} />
          </div>
        </div>
      </div>
    </div>
  );
}
