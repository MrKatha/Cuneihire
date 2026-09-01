import Image from "next/image";

/**
 * The Cuneihire brand mark. As of 2026-09-01 this is literally Cuneihive's
 * own mark (`/public/brand-mark.png`, sourced from F:\Cuneihive-V3\public\
 * logo.png) — operator decision: Cuneihire keeps its own distinct palette/
 * type/layout, but shares the parent brand's actual logo glyph rather than
 * a lookalike. Previously this was a coded hexagon deliberately drawn to
 * *echo* Cuneihive's shape without reusing it (see docs/design.md and
 * docs/memory.md for that earlier reasoning) — superseded by this change.
 * No vector source exists for the real mark (Cuneihive-V3 only ships PNGs),
 * so it's a raster asset; at the sizes this renders in-app (~18-30px, all
 * downscaled from a 512x512 source) that's not a fidelity problem.
 * Server-safe, no hooks. Two variants:
 *  - "outline": the real Cuneihive logo image (the logo mark / wordmark lockup)
 *  - "solid": a plain filled hex — unrelated generic utility (status dots,
 *    list bullets), not the brand mark; unused today, kept for that future use
 *  - "wordmark": the logo image + "Cuneihire" text, the full brand lockup
 */
type HexMarkProps = {
  variant?: "outline" | "solid";
  size?: number;
  className?: string;
  color?: string;
};

const HEX_CLIP =
  "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)";

export default function HexMark({
  variant = "outline",
  size = 20,
  className = "",
  color,
}: HexMarkProps) {
  if (variant === "solid") {
    // This point set is a flat-top hexagon (points at left/right) — it's
    // only a REGULAR hexagon when the box is wider than it is tall by this
    // ratio. Applying it to a square box (the original bug here) skews it.
    const HEX_RATIO = 0.8660254; // = sin(60deg); height = width * HEX_RATIO
    return (
      <span
        aria-hidden
        className={className}
        style={{
          display: "inline-block",
          width: size,
          height: size * HEX_RATIO,
          background: color ?? "var(--accent)",
          clipPath: HEX_CLIP,
        }}
      />
    );
  }

  // Outline: the real Cuneihive mark, a square-canvas PNG — color/theming
  // isn't applicable to a raster asset, so `color` is a no-op here (no
  // caller passes it today; the mark just renders in its native black ink,
  // which already matches --ink on Cuneihire's single locked palette).
  return (
    <Image
      src="/brand-mark.png"
      alt=""
      aria-hidden
      width={size}
      height={size}
      className={className}
      style={{ display: "inline-block", width: size, height: size, objectFit: "contain" }}
    />
  );
}

export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}
    >
      <HexMark variant="outline" size={22} />
      <span className="brand" style={{ margin: 0 }}>
        Cuneihire
      </span>
    </span>
  );
}
