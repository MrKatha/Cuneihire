import { NextResponse } from "next/server";
import { decryptPassword, encryptPassword } from "@/lib/crypto";
import { getAuthedUserId } from "@/lib/aiClient";

// Auth + encryption-at-rest added (foundation hardening pass) — this route previously had zero auth and
// handed back the LinkedIn session cookie/raw headers in plaintext for AutoFetchModal.tsx to persist as-is.
// That plaintext (via storage.ts -> automailsend_app_state.cookie_li_at/cookie_jsessionid/
// auto_fetch_raw_headers) is a complete, working LinkedIn session — no password/MFA needed to use it, the
// single highest-value credential in this app. Mirrors verify/route.ts's existing SMTP-password pattern
// exactly: decrypt-if-needed before using the value, encrypt-if-not-already before handing it back.
export async function POST(req: Request) {
  try {
    const userId = await getAuthedUserId(req);
    if (!userId) {
      return NextResponse.json({ success: false, error: "Not signed in." }, { status: 401 });
    }

    const { liAt: liAtIn, jsessionid: jsessionidIn, rawHeaders: rawHeadersIn } = await req.json();

    if (!liAtIn || !jsessionidIn) {
      return NextResponse.json(
        { success: false, error: "Missing LinkedIn cookies" },
        { status: 400 }
      );
    }

    // Each of these may already be "enc:"-prefixed ciphertext (a previous Save already encrypted it) or
    // still plaintext (a fresh extraction from the extension) — unwrap to plaintext before actually using
    // any of them to talk to LinkedIn. decryptPassword() already passes non-"enc:"-prefixed text through
    // unchanged, so this is safe either way.
    let liAt: string, jsessionid: string, rawHeaders: string;
    try {
      liAt = decryptPassword(liAtIn);
      jsessionid = decryptPassword(jsessionidIn);
      rawHeaders = rawHeadersIn ? decryptPassword(rawHeadersIn) : rawHeadersIn;
    } catch {
      return NextResponse.json(
        { success: false, error: "Failed to decrypt existing LinkedIn session. Please reconnect." },
        { status: 400 }
      );
    }

    let fetchHeaders: any = {
      "csrf-token": jsessionid.replace(/"/g, ''),
      "cookie": `li_at=${liAt}; JSESSIONID=${jsessionid}`,
      "accept": "application/vnd.linkedin.normalized+json+2.1",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    };

    if (rawHeaders) {
      try {
        const parsed = JSON.parse(rawHeaders);
        fetchHeaders = { ...parsed };

        // Ensure critical ones are correct
        fetchHeaders["csrf-token"] = jsessionid.replace(/"/g, '');
        // We do not overwrite Cookie entirely, but ensure li_at and JSESSIONID are in it
        if (fetchHeaders["Cookie"]) {
           if (!fetchHeaders["Cookie"].includes("li_at=")) {
             fetchHeaders["Cookie"] += `; li_at=${liAt}`;
           }
        } else {
           fetchHeaders["cookie"] = `li_at=${liAt}; JSESSIONID=${jsessionid}`;
        }
      } catch (e) {
        // use defaults if parse fails
      }
    }

    // Ping LinkedIn Voyager API to verify cookies are valid
    const res = await fetch("https://www.linkedin.com/voyager/api/me", {
      method: "GET",
      headers: fetchHeaders,
      redirect: "manual",
    });

    if (res.ok || res.status === 200) {
      // Encrypt at rest before handing back to the caller to persist. "Already enc:-prefixed? pass through
      // untouched" avoids needlessly re-encrypting (new IV) a value that's already safely stored on every
      // repeat Save — same idiom verify/route.ts's encryptedPassword field already uses.
      const encryptedLiAt = liAtIn.startsWith("enc:") ? liAtIn : encryptPassword(liAt);
      const encryptedJsessionid = jsessionidIn.startsWith("enc:") ? jsessionidIn : encryptPassword(jsessionid);
      const encryptedRawHeaders = !rawHeadersIn
        ? rawHeadersIn
        : rawHeadersIn.startsWith("enc:")
        ? rawHeadersIn
        : encryptPassword(rawHeaders);
      return NextResponse.json({ success: true, encryptedLiAt, encryptedJsessionid, encryptedRawHeaders });
    } else {
      // Typically returns 401 if unauthorized
      return NextResponse.json(
        { success: false, error: "Invalid or expired LinkedIn cookies" },
        { status: 401 }
      );
    }
  } catch (error: any) {
    console.error("LinkedIn verification error:", error);
    return NextResponse.json(
      { success: false, error: `Network error: ${error?.message || 'Failed to verify cookies'}` },
      { status: 500 }
    );
  }
}
