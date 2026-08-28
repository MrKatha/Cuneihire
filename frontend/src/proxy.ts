import { NextResponse, type NextRequest } from "next/server";

// Admin subdomain split (2026-08-29). NOT middleware.ts — Next 16 deprecated that file convention in
// favor of proxy.ts with an exported `proxy()` function (Node.js runtime only, unconfigurable). See
// AGENTS.md's warning about this repo's Next version having breaking changes vs. training data; confirmed
// directly against frontend/node_modules/next/dist/docs/ before writing this.
//
// Two hosts share this one deployment:
//   - hire.cuneihive.com (today) / cuneihire.com (later, once acquired) — the normal candidate/recruiter
//     app. /admin-panel and /api/admin/* are genuinely unreachable here, not just hidden from nav.
//   - admin.hire.cuneihive.com (today) / admin.cuneihire.com (later) — staff only. Everything except the
//     shared auth pages gets rewritten to /admin-panel so the URL bar still shows the admin host.
//
// verifyAdmin() on every /api/admin/* route (frontend/src/lib/adminAuth.ts) stays the real security
// boundary regardless of host — this split reduces discoverability, it is not a substitute for that check.
export function proxy(request: NextRequest) {
  const { pathname, hostname } = request.nextUrl;
  const isAdminHost = hostname.startsWith("admin.");

  if (!isAdminHost) {
    // 404, not 401/403 — indistinguishable from a path that never existed. Proxy runs before filesystem
    // routing, so the real route code behind these paths never executes on this host at all.
    if (pathname === "/admin-panel" || pathname.startsWith("/api/admin/")) {
      return new NextResponse(null, { status: 404 });
    }
    return NextResponse.next();
  }

  // Admin host — shared auth pages and every API route pass through untouched.
  const passthrough = ["/login", "/forgot-password", "/reset-password", "/auth/callback"];
  if (passthrough.includes(pathname) || pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Staff accounts are provisioned by a super admin, not self-serve.
  if (pathname === "/signup") {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // Everything else on the admin host — including "/" — is the admin panel.
  if (pathname !== "/admin-panel") {
    return NextResponse.rewrite(new URL("/admin-panel" + request.nextUrl.search, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
