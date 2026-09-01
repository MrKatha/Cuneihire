const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
const MAILTO_RE = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
const LOCAL_MOBILE_RE = /\b03\d{2}[\s.-]?\d{7}\b|\b03\d{9}\b/g;
const CONTEXT_PHONE_RE = /(?:(?:ph|phone|call|tel|mobile|cell|whatsapp|wa|contact|reach(?:\s+me)?\s+at|\+)\b[:\s\-]*)(?:\+?\d{1,4}[\s.-]?)?\(?\b0?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/gi;
const WA_LINK_RE = /(?:https?:\/\/)?(?:wa\.me\/|api\.whatsapp\.com\/send\?phone=)(\+?\d{8,15})/gi;
const WA_MENTION_RE = /(?:whatsapp|whats\s*app|wa\.me|dm\s*on\s*whatsapp|contact\s*on\s*whatsapp)[^\d+]{0,40}(\+?\d[\d\s\-()]{7,18}\d)/gi;
const PHONE_RE = /(?:\+?\d{1,3}[\s\-]?)?(?:\(?\d{2,4}\)?[\s\-]?)?\d{3,4}[\s\-]?\d{3,4}(?:[\s\-]?\d{2,4})?/g;

function unescapePayload(rawStr) {
  return String(rawStr)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\\\"/g, '"')
    .replace(/\\\"/g, '"')
    .replace(/\"/g, '"')
    .replace(/\\n/g, ' ')
    .replace(/\\\\/g, '\\');
}

function decodeBufferData(rawStr) {
  const bufferRegex = /"data"\s*:\s*\[([\d,\s]+)\]/g;
  let decoded = '';
  let match;
  while ((match = bufferRegex.exec(rawStr)) !== null) {
    try {
      const numbers = match[1].split(',').map((n) => parseInt(n.trim(), 10));
      decoded += ' ' + String.fromCharCode(...numbers);
    } catch (e) { }
  }
  return decoded;
}

function cleanPhoneNumber(phoneStr) {
  if (!phoneStr) return null;
  let cleaned = phoneStr.replace(/^(?:ph|phone|call|tel|mobile|cell|whatsapp|wa|contact|reach(?:\s+me)?\s+at)[:\s\-]*/i, '').trim();
  const digitsOnly = cleaned.replace(/\D/g, '');
  if (digitsOnly.length < 9 || digitsOnly.length > 13) return null;
  if (/^(17\d{11}|2707|7643|8145|5337|1785|1761)/.test(digitsOnly)) return null;
  if (/^(\d)\1+$/.test(digitsOnly)) return null;
  return cleaned;
}

function cleanPhoneAdvanced(p) {
  return String(p).replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
}

// A "children" slot in this wire format is either literal text (what we want) or a lazy reference to
// another chunk, serialized as "$L<hexId>" (e.g. "$L15", "$L4c") -- structurally the same convention
// this file's own referencersOf() already parses on the other side of a reference. The old filter here
// only excluded the literal string "$undefined", so every "$L<hex>" reference token was captured as if
// it were a real line of post text and joined straight into context_text (confirmed live, 2026-09-02 --
// every one of 77 scraped job posts in the DB had this contamination, e.g. "$L15\n$L4c\n$L5c\n...\n📍
// Location: Mumbai..."). Match requires the "L" specifically (not the bare "$<hex>" form
// referencersOf() also tolerates elsewhere) so a genuine dollar amount like "$15" or "$101" in real post
// text is never at risk of being mistaken for one of these.
const CHUNK_REFERENCE_RE = /^\$L[0-9a-fA-F]+$/;

// Same contamination class as CHUNK_REFERENCE_RE above, but for extractInitialContacts below — the
// deepest legacy fallback, which truncates the raw payload directly rather than parsing it line-by-line,
// so it never goes through extractLineTexts' filtering at all. \b keeps this from ever touching a real
// dollar amount like "$15" or "$101" mid-sentence (those aren't followed immediately by "L").
function stripChunkReferenceTokens(text) {
  return text.replace(/\$L[0-9a-fA-F]+\b/g, '').replace(/\s{2,}/g, ' ').trim();
}

function extractLineTexts(chunk) {
  const lines = [];
  const re = /"children"\s*:\s*\[\s*(?:null|\[[\s\S]*?\])\s*,\s*"((?:\\.|[^"\\])*)"\s*\]/g;
  let m;
  while ((m = re.exec(chunk)) !== null) {
    const line = unescapePayload(m[1]);
    if (line && line !== '$undefined' && !CHUNK_REFERENCE_RE.test(line)) lines.push(line);
  }
  return lines;
}

function extractEmailsFrom(text) {
  const found = [];
  MAILTO_RE.lastIndex = 0;
  let mm;
  while ((mm = MAILTO_RE.exec(text)) !== null) found.push(mm[1].toLowerCase());
  const standard = text.match(EMAIL_RE) || [];
  for (const e of standard) found.push(e.toLowerCase());
  return [...new Set(found.filter((e) => !e.includes('linkedin.com')))];
}

function extractPhonesFrom(text) {
  const candidates = [];
  const localMatches = text.match(LOCAL_MOBILE_RE) || [];
  candidates.push(...localMatches);
  CONTEXT_PHONE_RE.lastIndex = 0;
  let cm;
  while ((cm = CONTEXT_PHONE_RE.exec(text)) !== null) candidates.push(cm[0]);
  return [...new Set(candidates.map(cleanPhoneNumber).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Per-post attribution (added 2026-08-17)
//
// LinkedIn's content-search response embeds one big JSON array
// (`window.__como_rehydration__ = [ "id:content", "id:content", ... ]`) which, once properly
// JSON.parsed and concatenated, is itself a stream of "<hexId>:<value>\n<hexId>:<value>\n..."
// chunks (a React-Server-Components-style wire format) — some chunks are raw post metadata
// (author, activityId, postSlugUrl), others are the actual rendered UI tree (where contact info
// like an email in "apply by emailing X" text actually lives). A chunk holding a contact's text
// typically references its owning post's metadata chunk directly via a "$<id>" prop within a few
// hops — validated against a real captured sample (see docs/memory.md for how this was derived).
//
// This gives each contact its OWN post's url/text instead of the old behavior of stamping every
// contact found on a page with the concatenation of every post found on that page.
// ---------------------------------------------------------------------------

function parseComoChunks(rawStr) {
  try {
    const startMarker = 'window.__como_rehydration__ = [';
    const startIdx = rawStr.indexOf(startMarker);
    if (startIdx === -1) return null;

    const arrayStart = startIdx + startMarker.length - 1;
    const nextScriptIdx = rawStr.indexOf('<script', startIdx + startMarker.length);
    const arraySlice = rawStr.slice(arrayStart, nextScriptIdx === -1 ? undefined : nextScriptIdx);
    const lastBracket = arraySlice.lastIndexOf(']');
    if (lastBracket === -1) return null;

    const parsedArray = JSON.parse(arraySlice.slice(0, lastBracket + 1));
    const full = parsedArray.join('');

    const chunkRe = /(?:^|\n)([0-9a-f]+):/g;
    const starts = [];
    let m;
    while ((m = chunkRe.exec(full)) !== null) {
      starts.push({ id: m[1], headerIndex: m.index, contentStart: chunkRe.lastIndex });
    }
    if (starts.length === 0) return null;

    const chunks = new Map();
    for (let i = 0; i < starts.length; i++) {
      const end = i + 1 < starts.length ? starts[i + 1].headerIndex : full.length;
      const text = full.slice(starts[i].contentStart, end);
      if (!chunks.has(starts[i].id)) chunks.set(starts[i].id, text);
    }
    return chunks;
  } catch (err) {
    return null;
  }
}

function findPostsInChunks(chunks) {
  const posts = [];
  for (const [id, text] of chunks) {
    const urlM = text.match(/"postSlugUrl":"([^"]+)"/);
    if (!urlM) continue;
    const actorM = text.match(/"actorName":"([^"]*)"/);
    posts.push({ chunkId: id, url: urlM[1], actor: actorM ? actorM[1] : '' });
  }
  return posts;
}

function referencersOf(chunks, targetId) {
  const re = new RegExp('\\$L?' + targetId + '\\b');
  const res = [];
  for (const [id, text] of chunks) {
    if (id === targetId) continue;
    if (re.test(text)) res.push(id);
  }
  return res;
}

// Walk up the reference tree from a contact's chunk, looking for the post it belongs to: either a
// direct hit on a post's own metadata chunk, or an ancestor chunk that mentions a known post's
// author name. Returns { post, ancestorChunkIds } or null if nothing was found within maxDepth hops
// (an honest "unknown" — never a guess).
function findOwningPost(chunks, startChunkId, posts, maxDepth = 6) {
  const postChunkIds = new Set(posts.map((p) => p.chunkId));
  let frontier = [startChunkId];
  const visited = new Set(frontier);
  const path = [];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const next = [];
    for (const id of frontier) {
      for (const r of referencersOf(chunks, id)) {
        if (!visited.has(r)) {
          visited.add(r);
          next.push(r);
        }
      }
    }
    path.push(...next);

    for (const id of next) {
      if (postChunkIds.has(id)) {
        return { post: posts.find((p) => p.chunkId === id), ancestorChunkIds: path };
      }
    }
    for (const id of next) {
      const text = chunks.get(id);
      const hit = posts.find((p) => p.actor && text.includes(p.actor));
      if (hit) return { post: hit, ancestorChunkIds: path };
    }

    if (next.length === 0) return null;
    frontier = next;
  }
  return null;
}

function contextTextFor(chunks, contactChunkId, ancestorChunkIds) {
  const pieces = [contactChunkId, ...(ancestorChunkIds || []).slice(0, 2)]
    .map((id) => chunks.get(id))
    .filter(Boolean)
    .flatMap((text) => extractLineTexts(text));
  const joined = [...new Set(pieces)].join(' ').trim();
  return joined ? joined.slice(0, 2000) : null;
}

// Primary extraction path: per-post-attributed contacts. Returns null if the page doesn't match the
// expected wire format (caller should fall back to the legacy page-level extractors below).
function extractContactsWithAttribution(rawStr) {
  const chunks = parseComoChunks(rawStr);
  if (!chunks) return null;

  const posts = findPostsInChunks(chunks);
  if (posts.length === 0) return null;

  const groups = [];
  for (const [chunkId, text] of chunks) {
    if (posts.some((p) => p.chunkId === chunkId)) continue; // skip raw metadata chunks themselves
    const emails = extractEmailsFrom(text);
    const phones = extractPhonesFrom(text);
    if (emails.length === 0 && phones.length === 0) continue;

    const owner = findOwningPost(chunks, chunkId, posts);
    groups.push({
      emails,
      phones,
      source_url: owner ? owner.post.url : null,
      contextText: owner ? contextTextFor(chunks, chunkId, owner.ancestorChunkIds) : null,
      // The post's author (`actorName`) was already being read to help find the owning post above —
      // previously discarded once attribution succeeded. Kept here so it can be saved and used to
      // address a real person instead of the AI guessing a name from noisy post text. Empty string
      // from LinkedIn (anonymous/hidden actor) is treated the same as "unknown".
      authorName: owner && owner.post.actor ? owner.post.actor : null,
    });
  }

  return { groups, postsFound: posts.length };
}

// --- Legacy page-level extractors (fallback when the wire format above isn't recognized, e.g. the
// paginated-results endpoint hasn't been validated against a live sample yet). Known limitation:
// stamps every contact found on the page with every post URL found on the page — see
// docs/architecture.md / docs/memory.md. ---

function extractInitialContacts(rawStr) {
  const decodedBuffers = decodeBufferData(rawStr);
  const cleanText = unescapePayload(rawStr + ' ' + decodedBuffers);

  const uniqueEmails = extractEmailsFrom(cleanText);
  const uniquePhones = extractPhonesFrom(cleanText);

  const urlMatches = cleanText.match(/"postSlugUrl"\s*:\s*"([^"]+)"/g) || [];
  const uniqueUrls = [...new Set(urlMatches.map(m => m.match(/"postSlugUrl"\s*:\s*"([^"]+)"/)[1]))];
  // 2026-08-25 fix: this used to be `uniqueUrls.join(", ")` — a comma-joined string of every post URL
  // found on the page, stamped onto every contact from that page (see this section's header comment on
  // the known per-contact-attribution limitation). That string was never a valid single URL, so every
  // "View post" link in JAMS was broken — clicking it tried to navigate to the literal joined string.
  // No per-contact attribution exists in this legacy path (that's the whole reason it's legacy), so
  // there's no way to pick the *correct* one of several URLs found on a page — but the first one found is
  // a real, clickable, still-usually-relevant link, which beats a guaranteed-broken one every time.
  const source_urls = uniqueUrls[0] || null;

  return { emails: uniqueEmails, phones: uniquePhones, source_urls, contextText: stripChunkReferenceTokens(cleanText).substring(0, 5000) };
}

function extractPaginatedContacts(rawStr) {
  // 1. Extract emails from the ENTIRE decoded payload (safe because EMAIL_RE is very specific)
  const cleanText = unescapePayload(rawStr + ' ' + decodeBufferData(rawStr));
  const emails = extractEmailsFrom(cleanText);

  // 2. Extract phones only from human-readable text nodes to avoid random JSON numbers
  const text = extractLineTexts(rawStr).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const whatsappNumbers = [];
  for (const re of [WA_LINK_RE, WA_MENTION_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const n = cleanPhoneAdvanced(m[1]);
      if (n.replace(/\D/g, '').length >= 8) whatsappNumbers.push(n);
    }
  }
  const wa = [...new Set(whatsappNumbers)];

  const phones = [...new Set(
    (text.match(PHONE_RE) || [])
      .map(cleanPhoneAdvanced)
      .filter((p) => {
        const d = p.replace(/\D/g, '');
        return d.length >= 10 && d.length <= 15 && !wa.includes(p);
      })
  )];

  const urlMatches = cleanText.match(/"postSlugUrl"\s*:\s*"([^"]+)"/g) || [];
  const uniqueUrls = [...new Set(urlMatches.map(m => m.match(/"postSlugUrl"\s*:\s*"([^"]+)"/)[1]))];
  // Same fix as extractInitialContacts above — a single real URL, not a broken comma-joined string.
  const source_urls = uniqueUrls[0] || null;

  return { emails, phones: [...new Set([...wa, ...phones])], source_urls, contextText: text.substring(0, 5000) };
}

module.exports = {
  extractContactsWithAttribution,
  extractInitialContacts,
  extractPaginatedContacts,
  // Exported 2026-08-31 for jobspy.worker.js to reuse the exact same email regex/cleanup against a
  // JobSpy listing's description text, instead of a second copy of the same logic.
  extractEmailsFrom,
};
