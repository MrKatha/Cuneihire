import Link from "next/link";
import HexMark from "@/components/ui/HexMark";

const POLICY_PAGES = [
  { href: "/terms", label: "Terms of Service" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/refund-policy", label: "Refund Policy" },
] as const;

// Shared shell for the three public policy pages (Terms, Privacy, Refunds) — one place for the header,
// cross-links between them, and the "last updated" stamp, so the pages read as one consistent document set
// rather than three one-offs. Server component (no hooks) — matches HexMark's own no-client-JS convention.
export default function LegalPageShell({
  title,
  lastUpdated,
  activeHref,
  children,
}: {
  title: string;
  lastUpdated: string;
  activeHref: (typeof POLICY_PAGES)[number]["href"];
  children: React.ReactNode;
}) {
  return (
    <div className="w-full flex-grow" style={{ background: "var(--bg)" }}>
      <header className="max-w-3xl mx-auto px-6 pt-10 pb-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <HexMark variant="outline" size={26} />
          <span
            className="font-semibold tracking-tight"
            style={{ fontFamily: "var(--font-display), Georgia, serif", color: "var(--ink)" }}
          >
            Cuneihire
          </span>
        </Link>
      </header>

      <div className="max-w-3xl mx-auto px-6 pb-20">
        <span className="label-eyebrow accent">Legal</span>
        <h1
          className="mt-2 mb-2 text-3xl md:text-4xl font-bold tracking-tight"
          style={{ fontFamily: "var(--font-display), Georgia, serif", color: "var(--ink)" }}
        >
          {title}
        </h1>
        <p className="text-sm mb-8" style={{ color: "var(--muted)" }}>
          Last updated: {lastUpdated}
        </p>

        <nav
          className="flex flex-wrap gap-1 mb-10 pb-6"
          style={{ borderBottom: "1px solid var(--line)" }}
        >
          {POLICY_PAGES.map((p) => (
            <Link
              key={p.href}
              href={p.href}
              className="btn ghost small"
              style={{
                borderBottom: p.href === activeHref ? "2px solid var(--accent)" : "2px solid transparent",
                borderRadius: 0,
                color: p.href === activeHref ? "var(--ink)" : "var(--muted)",
                fontWeight: p.href === activeHref ? 600 : 500,
              }}
            >
              {p.label}
            </Link>
          ))}
        </nav>

        <div className="legal-doc max-w-none">{children}</div>
      </div>
    </div>
  );
}
