/**
 * The Cuneihire brand mark — a hexagon, echoing the Cuneihive family shape
 * without reusing Cuneihive's own look (see docs/design.md). Server-safe,
 * no hooks. Three variants:
 *  - "outline": hairline-bordered hex (the logo mark / wordmark lockup)
 *  - "solid": a filled hex (status dots, list bullets)
 *  - "wordmark": outline hex + "Cuneihire" text, the full brand lockup
 */
type HexMarkProps = {
  variant?: "outline" | "solid";
  size?: number;
  className?: string;
  color?: string;
};

const HEX_CLIP =
  "polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)";

// This point set is a flat-top hexagon (points at left/right) — it's only a
// REGULAR hexagon when the box is wider than it is tall by this ratio.
// Applying it to a square box (the original bug here) squashes/stretches it.
const HEX_RATIO = 0.8660254; // = sin(60deg); height = width * HEX_RATIO

export default function HexMark({
  variant = "outline",
  size = 20,
  className = "",
  color,
}: HexMarkProps) {
  const width = size;
  const height = size * HEX_RATIO;

  if (variant === "solid") {
    return (
      <span
        aria-hidden
        className={className}
        style={{
          display: "inline-block",
          width,
          height,
          background: color ?? "var(--accent)",
          clipPath: HEX_CLIP,
        }}
      />
    );
  }

  // Outline: a CSS border is ignored on a clip-path'd element, so the
  // hairline is faked with two stacked clipped boxes.
  return (
    <span
      aria-hidden
      className={className}
      style={{
        position: "relative",
        display: "inline-block",
        width,
        height,
        background: color ?? "var(--ink)",
        clipPath: HEX_CLIP,
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: Math.max(1.4, size * 0.08),
          background: "var(--bg)",
          clipPath: HEX_CLIP,
        }}
      />
    </span>
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
