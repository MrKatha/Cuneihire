// Packages ../extension into public/cuneihire-extension.zip so the in-app "Download Extension" button
// always ships whatever is actually in extension/ — see AutoFetchModal.tsx's download link.
//
// Before this script existed (2026-08-25), that link pointed at a base64 zip blob hardcoded directly in
// AutoFetchModal.tsx's source, generated once at some point in the past and never regenerated — every
// later fix to extension/ (icons, manifest domains, rebrand) silently never reached anyone who clicked
// Download. Root cause of a real "extension doesn't detect the site" bug report. Runs as `prebuild` (see
// package.json) so it can never drift out of sync with extension/ again; also safe to run directly via
// `node scripts/build-extension-zip.js` for local testing without a full `next build`.
//
// Pure Node, no dependencies: ZIP entries stored uncompressed (method 0) — these files are a few KB
// total, so compression ratio doesn't matter, and STORE keeps the format implementation trivial/robust
// (no deflate framing to get right). CRC32 is the one non-trivial bit; standard textbook algorithm.
const fs = require("fs");
const path = require("path");

const EXT_DIR = path.join(__dirname, "..", "..", "extension");
const OUT_FILE = path.join(__dirname, "..", "public", "cuneihire-extension.zip");

function listFiles(dir, base = "") {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(listFiles(full, rel));
    else out.push({ rel, full });
  }
  return out;
}

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  return { time, dosDate };
}

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { time, dosDate } = dosDateTime(new Date());

  for (const { rel, full } of files) {
    const data = fs.readFileSync(full);
    const crc = crc32(data);
    const nameBuf = Buffer.from(rel.replace(/\\/g, "/"), "utf8");

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8); // method 0 = store
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuf, eocd]);
}

const files = listFiles(EXT_DIR).filter((f) => !f.rel.startsWith(".") && f.rel !== "manifest.json.bak");
if (files.length === 0) {
  console.error(`build-extension-zip: no files found in ${EXT_DIR}`);
  process.exit(1);
}
const zip = buildZip(files);
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, zip);
console.log(`build-extension-zip: wrote ${OUT_FILE} (${zip.length} bytes, ${files.length} files: ${files.map((f) => f.rel).join(", ")})`);
