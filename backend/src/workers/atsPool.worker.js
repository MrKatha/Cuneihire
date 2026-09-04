const pc = require("picocolors");
const { supabase } = require("../config/supabase");
const { extractEmailsFrom } = require("../services/extraction.service");
const { scoreJobMatch } = require("../services/ai.service");
const { roleHasCriteria, computeAlgorithmicMatch, shouldEscalateToAI } = require("../services/matchAlgorithm.service");
const { ExecutionLogger } = require("../lib/logger");
const { getGlobalSettings } = require("../lib/globalSettings");
const { spendAiCredit } = require("../lib/aiCredits");

// Internal ATS job pool search (2026-09-04) -- operator: "we should be able to choose only this database to
// fulfill our overall package requirements... whenever the user provides a keyword... it will look for jobs
// in our database first." Queries automailsend_ats_job_pool (populated by the separate, scheduled
// backend/src/scripts/ats_pool_ingest.py batch job -- see that table's own comment in supabase_setup.sql for
// the full sourcing design) instead of calling any live external API.
//
// Mirrors jobspy.worker.js's overall shape (dedup -> per-candidate match scoring -> strictness gate ->
// insert) for the same reason that file mirrors scraper.worker.js rather than sharing code with it: heavy
// run-scoped closure state, zero test coverage, real risk in a shared refactor for no correctness benefit.
//
// Two deliberate differences from jobspy.worker.js:
// 1. NO AI job-provider-classification pass. That gate exists because a LinkedIn/Indeed post's *author*
//    might be a job-seeker, not an employer -- but every row in the ATS pool is, by construction, a posting
//    pulled directly from a company's own Greenhouse/Lever/Ashby/SmartRecruiters board. A job-seeker cannot
//    post their own "hire me" listing into another company's ATS. The ambiguity that gate protects against
//    doesn't exist for this source, so skipping it is a real, safe AI-credit saving, not a corner cut.
// 2. No fallback-trigger/shortfall computation to hand off to jobspy.worker.js. No "how many candidates does
//    this user still need" concept exists anywhere in this codebase (confirmed by investigation) --
//    daily_mail_limit is the one real, enforced volume lever, and it only governs SENDING, never sourcing.
//    Building genuine cross-worker orchestration (compute a shortfall, explicitly trigger jobspy for the
//    gap, coordinate against its own independent 60-minute loop) is real new complexity this pass
//    deliberately doesn't take on. Instead: this worker runs on its own much shorter interval (see
//    scheduler.js -- a local DB query has none of JobSpy's live-scraping rate-limit/blocking concerns, so it
//    can run far more often) so the fast, free, frequent source naturally fills most of a user's daily quota
//    before the slower external scrapers get many chances to contribute -- the same practical outcome as an
//    explicit "internal first" trigger, without inventing coordination machinery nothing else here has. An
//    explicit shortfall trigger is a clean fast-follow if this cadence-based approach proves insufficient.

const SEARCH_WINDOW_DAYS = 30; // matches ats_pool_ingest.py's own ingestion recency filter
const CANDIDATES_PER_KEYWORD = 25;

function toTsQuery(keyword) {
  // Plain keywords like "AI Automation Specialist" need every word ANDed together for Postgres'
  // to_tsquery, not passed as a literal phrase (which would require exact adjacency and match far too
  // narrowly). websearch_to_tsquery would be the friendlier fit but isn't exposed via supabase-js's
  // .textSearch(); building the boolean query by hand keeps this on a single library call.
  return keyword
    .split(/\s+/)
    .map((w) => w.replace(/[^a-zA-Z0-9]/g, ""))
    .filter(Boolean)
    .join(" & ");
}

async function processJobLogic(userId, logger, mappings, aiEnabled, aiCredits, aiTemperature, matchStrictness) {
  await logger.append("INFO", `Starting internal job-pool search for ${mappings.length} keyword(s)`);

  let remainingCredits = aiCredits || 0;
  let aiCreditsExhaustedLogged = false;
  const globalSettings = await getGlobalSettings();

  const allEmails = new Set();
  const { data: existingRecipients } = await supabase.from("automailsend_recipients").select("email").eq("user_id", userId);
  (existingRecipients || []).forEach((r) => { if (r.email) allEmails.add(r.email.toLowerCase()); });
  const { data: sentLogData } = await supabase.from("automailsend_sent_log").select("email").eq("user_id", userId);
  (sentLogData || []).forEach((r) => { if (r.email) allEmails.add(r.email.toLowerCase()); });
  await logger.append("SUCCESS", `Loaded ${allEmails.size} emails to skip (existing recipients + sent log).`);

  let totalInserted = 0;
  const successfullyInsertedEmails = [];
  const jobPostCache = new Map(); // pool source_url -> { id, needsScoring, matchScore, matchReasoning, matchSource } | null
  const sinceDate = new Date(Date.now() - SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  for (const mapping of mappings) {
    const { keyword, role: roleToAssign, roleDef } = mapping;
    const tsQuery = toTsQuery(keyword);
    if (!tsQuery) continue;

    let candidates;
    try {
      const { data, error } = await supabase
        .from("automailsend_ats_job_pool")
        .select("source_url, ats_type, title, company, location, is_remote, description, posted_at")
        .textSearch("fts", tsQuery, { type: "plain", config: "english" })
        .gte("posted_at", sinceDate)
        .order("posted_at", { ascending: false })
        .limit(CANDIDATES_PER_KEYWORD);
      if (error) throw error;
      candidates = data || [];
    } catch (err) {
      await logger.append("WARN", `Internal pool search failed for "${keyword}": ${err.message}`);
      continue;
    }
    await logger.append("SUCCESS", `Internal pool returned ${candidates.length} candidate(s) for "${keyword}"`);

    for (const candidate of candidates) {
      if (!candidate.source_url) continue;
      const description = candidate.description || "";

      const emails = [...new Set(extractEmailsFrom(description))].map((e) => e.toLowerCase());
      const newEmails = emails.filter((e) => !allEmails.has(e));
      // Same "reject before spending anything" ordering every other source uses -- v1 deliberately never
      // guesses a generic company email (docs/architecture.md's "Explicitly out of scope").
      if (newEmails.length === 0) continue;

      newEmails.forEach((e) => allEmails.add(e));

      await finalizeAndInsertCandidate({ candidate, description, roleToAssign, keyword, roleDef, newEmails });
    }
  }

  if (totalInserted === 0) {
    await logger.append("WARN", "No new records to insert.");
  } else {
    await logger.append("SUCCESS", `Total Unique Contacts Inserted: ${totalInserted}`);
  }

  return { inserted: totalInserted, emails: successfullyInsertedEmails, phones: [] };

  // --- helper below, hoisted for readability; closure over the state above ---

  async function finalizeAndInsertCandidate({ candidate, description, roleToAssign, keyword, roleDef, newEmails }) {
    let jobPost = jobPostCache.get(candidate.source_url);
    if (jobPost === undefined) {
      const { data, error } = await supabase
        .from("automailsend_job_posts")
        .upsert(
          { user_id: userId, source_url: candidate.source_url, context_text: description.slice(0, 5000) || null, source: "ats_pool" },
          { onConflict: "user_id,source_url" }
        )
        .select("id, match_analyzed_at, match_score, match_reasoning, match_source")
        .single();
      if (error) {
        await logger.append("WARN", `Failed to upsert pool job post (${candidate.source_url.slice(0, 60)}...): ${error.message}`);
        jobPost = null;
      } else {
        jobPost = {
          id: data.id,
          needsScoring: !data.match_analyzed_at,
          matchScore: data.match_score ?? null,
          matchReasoning: data.match_reasoning ?? null,
          matchSource: data.match_source ?? null,
        };
      }
      jobPostCache.set(candidate.source_url, jobPost);
    }

    const jobPostId = jobPost ? jobPost.id : null;
    let matchScore = jobPost ? jobPost.matchScore : null;
    let matchReasoning = jobPost ? jobPost.matchReasoning : null;
    let matchSource = jobPost ? jobPost.matchSource : null;

    const applyMatchResult = async (score, reasoning, source, algoResult) => {
      const fields = {
        match_score: score,
        match_reasoning: reasoning,
        match_source: source,
        match_analyzed_at: new Date().toISOString(),
        ...(algoResult ? { match_algo_score: algoResult.score, match_algo_reasoning: algoResult.reasoning } : {}),
      };
      await supabase.from("automailsend_job_posts").update(fields).eq("id", jobPostId);
      jobPost.needsScoring = false;
      matchScore = score;
      matchReasoning = reasoning;
      matchSource = source;
    };

    if (jobPost && jobPost.needsScoring && roleHasCriteria(roleDef)) {
      const algoResult = computeAlgorithmicMatch(description, roleDef);
      const escalate = shouldEscalateToAI(algoResult, roleDef, {
        aiEnabled,
        remainingCredits,
        lowThreshold: globalSettings.algo_match_escalate_low ?? 20,
        highThreshold: globalSettings.algo_match_escalate_high ?? 80,
        hasFreshMatchKeywords: false,
      });

      if (escalate) {
        try {
          const match = await scoreJobMatch(description, candidate.source_url, roleDef, aiTemperature, userId);
          const spent = await spendAiCredit(supabase, userId);
          remainingCredits = spent ? remainingCredits - 1 : 0;
          if (match) {
            await applyMatchResult(match.score, match.reasoning, "ai", algoResult);
            await logger.append("INFO", `Scored (AI) ${match.score}/100 for role '${roleToAssign}': ${match.reasoning}`);
          } else if (algoResult) {
            await applyMatchResult(algoResult.score, algoResult.reasoning, "algorithm", algoResult);
          }
        } catch (err) {
          if (algoResult) {
            await applyMatchResult(algoResult.score, algoResult.reasoning, "algorithm", algoResult);
            await logger.append("WARN", `AI match scoring failed for ${candidate.source_url}, used the algorithmic score ${algoResult.score} instead: ${err.message}`);
          } else {
            await logger.append("WARN", `Job match scoring failed for ${candidate.source_url}: ${err.message}`);
          }
        }
      } else if (algoResult) {
        await applyMatchResult(algoResult.score, algoResult.reasoning, "algorithm", algoResult);
        await logger.append("INFO", `Scored (algorithm, 0 AI credits) ${algoResult.score}/100 for role '${roleToAssign}': ${algoResult.reasoning}`);
      } else if (aiEnabled && remainingCredits <= 0 && !aiCreditsExhaustedLogged) {
        await logger.append("WARN", "Out of AI credits — pool listings needing AI-only judgment won't be scored for the rest of this run.");
        aiCreditsExhaustedLogged = true;
      }
    }

    if (matchScore != null && matchStrictness > 0 && matchScore < matchStrictness) {
      await logger.append(
        "INFO",
        `Not saving "${candidate.title}" — scored ${matchScore}/100 for role '${roleToAssign}' (below your ${matchStrictness} threshold): ${matchReasoning || "no reasoning given"}`
      );
      return;
    }

    for (const email of newEmails) {
      const { error } = await supabase.from("automailsend_recipients").insert({
        user_id: userId,
        email,
        phone: "",
        role: roleToAssign,
        title: candidate.title || keyword || "",
        source: "auto_fetch",
        job_post_id: jobPostId,
        context_text: description.slice(0, 5000) || null,
        source_url: candidate.source_url,
        author_name: candidate.company || null,
        ...(matchScore != null ? { match_score: matchScore, match_reasoning: matchReasoning, match_source: matchSource } : {}),
        scraped_at: new Date().toISOString(),
        status: "pending",
      });
      if (error) {
        await logger.append("ERROR", `Supabase insert error: ${error.message}`);
      } else {
        totalInserted++;
        allEmails.add(email);
        successfullyInsertedEmails.push(email);
      }
    }
  }
}

async function processJob(job) {
  const { user_id } = job.data;

  const { data: roleDefs, error: roleDefsErr } = await supabase.from("automailsend_role_defs").select("*").eq("user_id", user_id);
  if (roleDefsErr) {
    console.error(pc.red(`[ATS Pool Worker] Failed to load role defs for ${user_id}: ${roleDefsErr.message}`));
    return { inserted: 0, emails: [], phones: [] };
  }

  const mappings = (roleDefs || []).flatMap((d) => (d.keywords || []).map((keyword) => ({ keyword, role: d.key, roleDef: d })));
  if (mappings.length === 0) {
    return { inserted: 0, emails: [], phones: [] };
  }

  const { data: userState } = await supabase
    .from("automailsend_app_state")
    .select("is_blocked, ai_personalization_enabled, ai_credits, ai_temperature, ai_match_strictness")
    .eq("user_id", user_id)
    .single();

  if (userState && userState.is_blocked) {
    console.log(pc.red(`[ATS Pool Worker] User ${user_id} is blocked by admin. Halting.`));
    return { inserted: 0, emails: [], phones: [] };
  }

  const logger = new ExecutionLogger(user_id, "ats_pool");

  try {
    await logger.start(`Execution started for ${mappings.length} keyword(s) across ${roleDefs.length} role(s)`);
    const result = await processJobLogic(
      user_id,
      logger,
      mappings,
      !!userState?.ai_personalization_enabled,
      userState?.ai_credits || 0,
      userState?.ai_temperature,
      userState?.ai_match_strictness || 0
    );
    await logger.finish("success", `Execution finished. Inserted ${result.inserted} new unique records.`, { new_emails: result.emails, new_phones: [] });
    return result;
  } catch (err) {
    await logger.finish("error", `Execution failed: ${err.message}`, { stack: err.stack, name: err.name });
    return { inserted: 0, emails: [], phones: [] };
  }
}

module.exports = { processJob };
