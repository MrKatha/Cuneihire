// Content-aware pagination (2026-08-20, bug fix) — replaces blind fixed-pixel slicing with real
// measurement of the rendered resume. Both PDF generation (lib/resumePdf.tsx) and the live preview
// (ResumeBuilder.tsx) previously computed page breaks by dividing total height by one A4 page's height in
// pixels — a break could land in the middle of an experience entry even though the templates' own
// `breakInside: "avoid"` styling implied that couldn't happen (that CSS only affects native browser print,
// not html2canvas's raster capture or a plain scrolling preview div, so it was never actually doing
// anything for either consumer). `computePageBreaks` fixes both at once: it measures every
// `[data-page-atom="true"]` element (see lib/resumeTemplates/ModernTemplate.tsx's header comment for the
// convention) and only ever breaks at one of their bottom edges.
//
// Self-correcting scale (2026-08-20, second bug fix) — every measurement here goes through
// getBoundingClientRect(), which reflects whatever CSS transform/zoom is active on an ancestor at
// measurement time (deliberate — offsetWidth/scrollHeight ignore transforms entirely, which would silently
// break pagination only in a transformed/zoomed live preview, not lib/resumePdf.tsx's untransformed
// off-screen host). That used to mean the *returned* values were themselves in whatever scaled/zoomed
// "visual" space was active — fine for computing page *count* (scale-invariant, since it's all ratios
// within one constant factor) but wrong the moment a caller reapplies a returned value as a literal
// `top`/`transform: translateY()` on an element *inside that same transformed subtree*: `top`/`translateY`
// are always interpreted in an element's own *local* (pre-ancestor-transform) space, so an already-shrunk
// value gets shrunk a second time at paint time. Confirmed empirically (a 500px native offset, measured
// post-`scale(0.82)` as 410px, reapplied as `top: 410px` in the same scaled subtree, rendered at 336px — a
// real, compounding ~18% error, worse on later pages) — this was the actual root cause of the live
// preview's page markers looking wrong/compressed. Fixed by dividing every returned value by
// `containerRect.width / containerEl.offsetWidth` (offsetWidth ignores transform *and* zoom identically,
// confirmed empirically, so this ratio is exactly the active scale factor, 1 when nothing is applied) —
// `computePageBreaks` now always returns native-space px regardless of what's active on the ancestor chain,
// safe to reapply directly as a local `top`/`translateY` value by any caller. Swapping `transform` for CSS
// `zoom` was considered and rejected — tested identically wrong for this specific purpose; zoom has the
// same local-vs-visual-space disconnect as transform does here.

const A4_ASPECT = 297 / 210; // height / width
const MM_PER_INCH = 25.4;
const CSS_PX_PER_INCH = 96; // CSS's fixed absolute-length reference, unrelated to actual screen DPI

// Converts a CSS `mm` length to the px value it resolves to (browsers always use the 96px/in reference,
// regardless of device DPI) — lets callers pass a `pagePaddingMm` style setting into computePageBreaks as
// a plain px number, matching the units getBoundingClientRect()/offsetWidth already use.
export function mmToPx(mm: number): number {
  return (mm * CSS_PX_PER_INCH) / MM_PER_INCH;
}

export type PageBreaks = {
  // Page-end Y-offsets in native (untransformed) px, relative to containerEl's own top — the last entry is
  // the content's own natural end.
  breaks: number[];
  // Which page (0-indexed) each `data-atom-key` value landed on — lets a caller (the editor's scroll-sync)
  // ask "which page is this form entry's corresponding preview content on" without re-measuring.
  atomPage: Record<string, number>;
};

// `containerEl` must be the *content* element — no padding of its own (both callers pass a plain wrapper
// around the rendered template, sitting inside a separately-padded page box: ResumeBuilder.tsx's
// `previewContentRef` inside `.resume-print-area`, resumePdf.tsx's `contentRef` inside the padded
// `hostRef`). `paddingPx` is that page box's own padding (same value on all four sides, matching
// `ResumeStyleSettings.pagePaddingMm` via `mmToPx` above) — needed here because it eats into how much
// content actually fits on one physical page, on every page, not just the first/last.
//
// `safetySlackPx` (2026-08-24, bug fix) — a small deliberate reduction in how much a "full" page is
// allowed to hold, in the same native px-space as `paddingPx`. Exists for resumePdf.tsx's actual PDF
// output specifically: jsPDF has no true per-draw clip region for the continuous source image each page
// is sliced from (see its own comment for why one was tried and reverted), so it papers over the seam
// with a white mask instead — and a mask's edge, computed via one arithmetic path, isn't guaranteed to
// land pixel-perfectly on the same boundary the image was drawn from via a *different* arithmetic path,
// even though both start from the same `computePageBreaks` output; confirmed via a high-DPI render that a
// page packed to its exact literal capacity leaves a sub-millimetre trace of the next atom peeking through
// at the very bottom edge. Reserving a small slice of every "full" page's capacity up front means a page
// this function calls "full" never actually reaches the true physical boundary, giving that mask genuine,
// guaranteed room to work with. Defaults to 0 — ResumeBuilder.tsx's own live-preview call omits it
// deliberately, since that consumer clips its page window with real DOM `overflow: hidden`, not a
// white-rectangle mask, so it never had this specific bleed-through failure mode to guard against; adding
// unnecessary slack there would just very slightly under-fill each on-screen page for no benefit. A page
// that ends *early* (real content just runs out before filling the page at all) already has more slack
// than this reserve and is unaffected either way, regardless of caller.
export function computePageBreaks(containerEl: HTMLElement, paddingPx: number = 0, safetySlackPx: number = 0): PageBreaks {
  const containerRect = containerEl.getBoundingClientRect();
  // offsetWidth ignores transform/zoom; containerRect.width reflects it — their ratio is exactly the
  // active scale factor (1 when nothing is applied).
  const scale = containerEl.offsetWidth > 0 ? containerRect.width / containerEl.offsetWidth : 1;
  // Page-break bug fix (2026-08-20, third same-day follow-up): this used to compute pageHeightPx as
  // `containerRect.width * A4_ASPECT / scale` — i.e. it ran the *content* width (which already excludes
  // the page's own left/right padding) through the *outer* page's aspect ratio, and never subtracted the
  // page's top/bottom padding at all. Both mistakes make the computed page height too small, so pages fill
  // up early and the resume gets sliced into more pages than it actually needs (observed: 6 pages for
  // content that only needs ~4). Fixed by first reconstructing the true outer page width (content width +
  // left+right padding), deriving the outer page height from *that* via the aspect ratio, then subtracting
  // top+bottom padding — and now `safetySlackPx` too, see above — to get the height actually available for
  // content on every page.
  const outerWidthPx = containerEl.offsetWidth + 2 * paddingPx;
  const pageHeightPx = outerWidthPx * A4_ASPECT - 2 * paddingPx - safetySlackPx;
  if (pageHeightPx <= 0) return { breaks: [], atomPage: {} };
  const totalHeight = containerRect.height / scale;

  const atoms = Array.from(containerEl.querySelectorAll<HTMLElement>('[data-page-atom="true"]')).map((el) => {
    const r = el.getBoundingClientRect();
    return { bottom: (r.bottom - containerRect.top) / scale, key: el.getAttribute("data-atom-key") };
  });

  function assignAtomPages(breaks: number[]): Record<string, number> {
    const atomPage: Record<string, number> = {};
    for (const atom of atoms) {
      if (!atom.key) continue;
      let page = breaks.findIndex((b) => atom.bottom <= b + 0.5); // +0.5px slack for rounding
      if (page === -1) page = Math.max(breaks.length - 1, 0);
      atomPage[atom.key] = page;
    }
    return atomPage;
  }

  if (totalHeight <= pageHeightPx) {
    const breaks = [totalHeight];
    return { breaks, atomPage: assignAtomPages(breaks) };
  }

  if (atoms.length === 0) {
    // No atoms found (an empty resume, or a template that hasn't adopted the convention) — fall back to
    // blind fixed-height slicing rather than producing no pagination at all.
    const breaks: number[] = [];
    for (let y = pageHeightPx; y < totalHeight; y += pageHeightPx) breaks.push(y);
    breaks.push(totalHeight);
    return { breaks, atomPage: {} };
  }

  const breaks: number[] = [];
  let pageStart = 0;
  let i = 0;
  while (pageStart < totalHeight && i < atoms.length) {
    const pageLimit = pageStart + pageHeightPx;
    let lastFitBottom: number | null = null;
    let j = i;
    while (j < atoms.length && atoms[j].bottom <= pageLimit) {
      lastFitBottom = atoms[j].bottom;
      j++;
    }
    if (lastFitBottom === null) {
      // Not even the next atom fits within one page height on its own (a single entry taller than a
      // page) — force the break at its bottom rather than looping forever with no progress.
      lastFitBottom = Math.min(atoms[j].bottom, totalHeight);
      j = i + 1;
    }
    breaks.push(lastFitBottom);
    pageStart = lastFitBottom;
    i = j;
  }
  if (breaks.length === 0 || breaks[breaks.length - 1] < totalHeight) breaks.push(totalHeight);
  return { breaks, atomPage: assignAtomPages(breaks) };
}
