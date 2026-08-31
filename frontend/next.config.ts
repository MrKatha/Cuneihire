import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */

  // Baseline security response headers (2026-08-31, foundation hardening) — a deliberate scope cut short
  // of a hand-rolled Content-Security-Policy, which needs careful per-route testing to avoid silently
  // breaking something (inline scripts, the CDN scripts already in use, etc.) — flagged as a fast-follow,
  // not attempted here. These three are safe, low-risk defaults with no such interaction risk.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
