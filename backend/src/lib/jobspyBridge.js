const path = require("path");
const { spawn } = require("child_process");

// Node-side wrapper around jobspy_scrape.py (see that file's header for why a subprocess bridge exists at
// all — JobSpy has no CLI, only a Python function call). Params go in on stdin as JSON, the listing array
// comes back on stdout as JSON — keeps this process boundary to exactly one shape in each direction.
//
// JOBSPY_PYTHON_BIN lets the executable name differ per machine (Windows dev: "python"; the production
// droplet: "python3", the conventional name on Ubuntu) without hardcoding either — see docs/tools.md.
const PYTHON_BIN = process.env.JOBSPY_PYTHON_BIN || "python3";
const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "jobspy_scrape.py");
// JobSpy does real network scraping across however many results are requested — generous on purpose, a
// slow run should time out cleanly rather than wedge this worker's setInterval tick forever.
const TIMEOUT_MS = process.env.JOBSPY_TIMEOUT_MS ? parseInt(process.env.JOBSPY_TIMEOUT_MS, 10) : 180000;

// Returns an array of listings (see jobspy_scrape.py's header for the shape) or throws — callers should
// log-and-continue on rejection, same "one keyword's failure shouldn't kill the whole run" convention
// scraper.worker.js's own per-keyword try/catch already uses.
function runJobSpySearch({ searchTerm, location, resultsWanted, siteName }) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_BIN, [SCRIPT_PATH], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`jobspy_scrape.py timed out after ${TIMEOUT_MS}ms for search_term="${searchTerm}"`));
    }, TIMEOUT_MS);

    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // ENOENT here almost always means Python/the venv isn't set up on this machine yet — surface that
      // plainly rather than a bare "spawn python3 ENOENT".
      const hint = err.code === "ENOENT" ? ` (is Python installed and on PATH as "${PYTHON_BIN}"? set JOBSPY_PYTHON_BIN to override)` : "";
      reject(new Error(`Failed to start jobspy_scrape.py: ${err.message}${hint}`));
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        let parsedError = stderr.trim();
        try {
          parsedError = JSON.parse(stderr.trim()).error || parsedError;
        } catch {
          // stderr wasn't the expected JSON shape (e.g. a raw Python traceback) — fall back to it verbatim.
        }
        reject(new Error(`jobspy_scrape.py exited ${code}: ${parsedError || "(no stderr output)"}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(new Error(`jobspy_scrape.py returned invalid JSON: ${err.message}`));
      }
    });

    child.stdin.write(JSON.stringify({
      search_term: searchTerm,
      location: location || "",
      results_wanted: resultsWanted || 20,
      site_name: siteName || ["indeed"],
    }));
    child.stdin.end();
  });
}

module.exports = { runJobSpySearch };
