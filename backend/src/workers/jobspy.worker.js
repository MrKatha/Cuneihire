const pc = require("picocolors");
const { supabase } = require("../config/supabase");
const { extractEmailsFrom } = require("../services/extraction.service");
const { runJobSpySearch } = require("../lib/jobspyBridge");
const { scoreJobMatch, classifyJobPosts } = require("../services/ai.service");
const { roleHasCriteria, computeAlgorithmicMatch, shouldEscalateToAI, looksLikeJobPost } = require("../services/matchAlgorithm.service");
const { ExecutionLogger } = require("../lib/logger");
const { getGlobalSettings } = require("../lib/globalSettings");
const { spendAiCredit } = require("../lib/aiCredits");

// Open-source job sourcing via JobSpy (2026-08-31, v1 scoped to Indeed only — see docs/architecture.md's
// "Open-source job sourcing" section for the full reasoning and what's explicitly deferred to v2).
//
// Deliberately a SEPARATE, self-contained worker rather than a shared refactor of scraper.worker.js's
// saveContacts — that function closes over a lot of run-scoped mutable state (remainingCredits,
// aiCreditsExhaustedLogged, jobPostIdCache, ensureMatchKeywords) and this codebase has zero automated
// tests, so extracting it mid-feature carried real risk to the LinkedIn scraper (already live, already
// working) for a benefit (avoiding ~100 lines of parallel logic) that didn't justify that risk under this
// timeline. Some duplication with scraper.worker.js's saveContacts as a result — see that file for the
// LinkedIn-side twin of this same algorithm (dedup -> looksLikeJobPost -> job-post upsert -> match scoring
// -> match-strictness enforcement -> recipient insert).
//
// v1 also skips ai.service.js's generateMatchKeywords caching optimization (scraper.worker.js's
// ensureMatchKeywords) — a role with ai_instructions set still gets scored correctly via the direct
// scoreJobMatch AI call every time, just without that optimization's credit savings. Cheap to add later if
// Indeed-sourced volume makes it worth it; not essential for v1 correctness.
//
// AI job-provider classification (2026-09-03) — mirrors scraper.worker.js's collectContacts/
// finalizeAndInsertGroup/finalizeClassifiedContacts split (this file's own trip-wire comment, added the
// same day the LinkedIn side gained this gate, said to do exactly this before jobspy_sourcing_enabled ever
// goes live for real users). Indeed listings are structured job postings, not free-text social posts, so
// the "is the author actually offering a job" ambiguity this gate exists for is inherently smaller here
// than on LinkedIn — but it's not zero (a listing site can still surface a candidate's own "hire me" post),
// so this stays symmetric with the LinkedIn pipeline rather than assuming it away.

const RESULTS_PER_KEYWORD = process.env.JOBSPY_RESULTS_PER_KEYWORD ? parseInt(process.env.JOBSPY_RESULTS_PER_KEYWORD, 10) : 15;

async function processJobLogic(userId, logger, mappings, aiEnabled, aiCredits, aiTemperature, matchStrictness) {
  await logger.append("INFO", `Starting Indeed job search for ${mappings.length} keyword(s)`);

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
  const jobPostCache = new Map(); // job_url -> { id, needsScoring, matchScore, matchReasoning, matchSource } | null

  // Two-pass AI job-provider classification (2026-09-03) — mirrors scraper.worker.js's LinkedIn-side split,
  // per the trip-wire comment that used to live here: "Mirror scraper.worker.js's collectContacts/
  // finalizeAndInsertGroup/finalizeClassifiedContacts split before jobspy_sourcing_enabled is ever turned
  // on for real users." Every looksLikeJobPost-survivor across the WHOLE run is queued here; classified in
  // size-capped batches AFTER the mappings loop finishes — see finalizeClassifiedListings below. Same
  // reasoning as the LinkedIn side: the platform's one shared Gemini key is still on the 20-requests/day
  // free tier, so this must not turn into one Gemini call per listing.
  const classificationQueue = [];
  const CLASSIFY_BATCH_SIZE = 20;

  for (const mapping of mappings) {
    const { keyword, role: roleToAssign, roleDef } = mapping;
    const location = (Array.isArray(roleDef.preferred_locations) && roleDef.preferred_locations[0]) || "";

    await logger.append("INFO", `Searching Indeed for "${keyword}"${location ? ` in ${location}` : ""} (role: ${roleToAssign})`);
    let listings;
    try {
      listings = await runJobSpySearch({ searchTerm: keyword, location, resultsWanted: RESULTS_PER_KEYWORD });
    } catch (err) {
      await logger.append("WARN", `Indeed search failed for "${keyword}": ${err.message}`);
      continue;
    }
    await logger.append("SUCCESS", `Indeed returned ${listings.length} listing(s) for "${keyword}"`);

    for (const listing of listings) {
      if (!listing.job_url) continue;
      const description = listing.description || "";

      // Union JobSpy's own `emails` field (its regex pass over the listing) with our own extractEmailsFrom
      // over the same description — belt and suspenders, cheap, and keeps this in sync with any future
      // change to this app's own email-detection rules automatically. 2026-09-03 fix (found via a real
      // end-to-end test): JobSpy's own `emails` field was being trusted as literal, already-valid email
      // strings and inserted as-is — a real run produced a bare "w" as a "recipient email." Routing
      // `listing.emails` back through this app's own extractEmailsFrom (same regex/validation the
      // description already goes through) instead of trusting it raw fixes that, for free — no new export
      // needed.
      const emails = [...new Set(extractEmailsFrom([...(listing.emails || []), description].join(" ")))].map((e) => e.toLowerCase());
      const newEmails = emails.filter((e) => !allEmails.has(e));
      // No email discoverable in the listing text -> skip entirely (v1 deliberately does not guess a
      // generic company email — see docs/architecture.md's "Explicitly out of scope" for why). Same
      // "reject before spending anything" ordering scraper.worker.js's saveContacts already uses.
      if (newEmails.length === 0) continue;

      const jobPostCheck = looksLikeJobPost(description);
      if (jobPostCheck.verdict === "not_a_job") {
        await logger.append("INFO", `Skipped a non-job Indeed listing for role '${roleToAssign}': ${jobPostCheck.reasoning}`);
        continue;
      }

      // Claim these emails NOW, at collection time — not at insert time — for the same reason as the
      // LinkedIn side: classification is deferred until the whole run finishes, so without claiming here,
      // the same new email surfacing on two different listings found via different keywords in this same
      // run (both still awaiting classification) could both survive this dedup check and both reach the
      // insert step. Trade-off, accepted as bounded and rare: if THIS listing is later rejected by
      // classification, a second legitimate listing with the same email later in this same run won't get a
      // chance until the NEXT run (allEmails reloads fresh from the DB every run, see above).
      newEmails.forEach((e) => allEmails.add(e));

      classificationQueue.push({ listing, description, roleToAssign, keyword, roleDef, newEmails });
    }
  }

  await finalizeClassifiedListings();

  if (totalInserted === 0) {
    await logger.append("WARN", "No new records to insert.");
  } else {
    await logger.append("SUCCESS", `Total Unique Contacts Inserted: ${totalInserted}`);
  }

  return { inserted: totalInserted, emails: successfullyInsertedEmails, phones: [] };

  // --- helpers below, hoisted for readability; closures over the state above ---

  async function finalizeAndInsertListing({ listing, description, roleToAssign, keyword, roleDef, newEmails }, aiDescription) {
      let jobPost = jobPostCache.get(listing.job_url);
      if (jobPost === undefined) {
        const { data, error } = await supabase
          .from("automailsend_job_posts")
          .upsert(
            { user_id: userId, source_url: listing.job_url, context_text: description.slice(0, 5000) || null, source: "jobspy_indeed" },
            { onConflict: "user_id,source_url" }
          )
          .select("id, match_analyzed_at, match_score, match_reasoning, match_source")
          .single();
        if (error) {
          await logger.append("WARN", `Failed to upsert Indeed job post (${listing.job_url.slice(0, 60)}...): ${error.message}`);
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
        jobPostCache.set(listing.job_url, jobPost);
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
          hasFreshMatchKeywords: false, // v1 skips the AI-match-keyword caching optimization — see header comment
        });

        if (escalate) {
          try {
            const match = await scoreJobMatch(description, listing.job_url, roleDef, aiTemperature, userId);
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
              await logger.append("WARN", `AI match scoring failed for ${listing.job_url}, used the algorithmic score ${algoResult.score} instead: ${err.message}`);
            } else {
              await logger.append("WARN", `Job match scoring failed for ${listing.job_url}: ${err.message}`);
            }
          }
        } else if (algoResult) {
          await applyMatchResult(algoResult.score, algoResult.reasoning, "algorithm", algoResult);
          await logger.append("INFO", `Scored (algorithm, 0 AI credits) ${algoResult.score}/100 for role '${roleToAssign}': ${algoResult.reasoning}`);
        } else if (aiEnabled && remainingCredits <= 0 && !aiCreditsExhaustedLogged) {
          await logger.append("WARN", "Out of AI credits — Indeed listings needing AI-only judgment won't be scored for the rest of this run.");
          aiCreditsExhaustedLogged = true;
        }
      }

      if (matchScore != null && matchStrictness > 0 && matchScore < matchStrictness) {
        await logger.append(
          "INFO",
          `Not saving "${listing.title}" — scored ${matchScore}/100 for role '${roleToAssign}' (below your ${matchStrictness} threshold): ${matchReasoning || "no reasoning given"}`
        );
        return;
      }

      for (const email of newEmails) {
        const { error } = await supabase.from("automailsend_recipients").insert({
          user_id: userId,
          email,
          phone: "",
          role: roleToAssign,
          title: listing.title || keyword || "",
          source: "auto_fetch",
          job_post_id: jobPostId,
          context_text: description.slice(0, 5000) || null,
          source_url: listing.job_url,
          author_name: null, // JobSpy has no contact-person field, only a company name — see docs/architecture.md
          ...(matchScore != null ? { match_score: matchScore, match_reasoning: matchReasoning, match_source: matchSource } : {}),
          // AI-classified job description (2026-09-03) — the same batched AI read that decided this listing
          // is a real job posting also produced this clean, formatted description; no separate summarization
          // call. Only set when classification actually ran and accepted this listing — see
          // finalizeClassifiedListings below.
          ...(aiDescription ? { ai_summary: aiDescription, ai_summary_generated_at: new Date().toISOString() } : {}),
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

  // Batched AI job-provider classification, run ONCE after the entire mappings loop finishes — not per
  // keyword, not per listing. Mirrors scraper.worker.js's finalizeClassifiedContacts exactly (see that
  // file's comments for the full quota-safety reasoning). Fails open on any unavailability.
  async function finalizeClassifiedListings() {
    if (classificationQueue.length === 0) return;

    // Dedup by job_url — the same listing can be queued multiple times (different new email, different
    // keyword) but only needs ONE classification read.
    const postsByUrl = new Map();
    for (const entry of classificationQueue) {
      const url = entry.listing.job_url;
      if (!postsByUrl.has(url)) postsByUrl.set(url, { contextText: entry.description, entries: [] });
      postsByUrl.get(url).entries.push(entry);
    }
    const distinctPosts = [...postsByUrl.values()];

    await logger.append(
      "INFO",
      `Classifying ${distinctPosts.length} candidate Indeed listing(s) (${classificationQueue.length} contact(s) queued) with AI before saving any of them...`
    );

    let classificationUnavailable = false;
    for (let i = 0; i < distinctPosts.length; i += CLASSIFY_BATCH_SIZE) {
      const chunk = distinctPosts.slice(i, i + CLASSIFY_BATCH_SIZE);
      let results = null;

      if (classificationUnavailable) {
        // Already logged once below — don't spam, don't retry a budget/endpoint that just failed.
      } else if (!aiEnabled || !(remainingCredits > 0)) {
        await logger.append(
          "WARN",
          `AI job-provider classification unavailable (${!aiEnabled ? "AI personalization off" : "out of AI credits"}) — the remaining ${distinctPosts.length - i} candidate listing(s) will be saved unclassified this run, same as before this feature existed.`
        );
        classificationUnavailable = true;
      } else {
        try {
          results = await classifyJobPosts(chunk.map((p) => ({ contextText: p.contextText })), aiTemperature, userId);
          const spent = await spendAiCredit(supabase, userId);
          remainingCredits = spent ? remainingCredits - 1 : 0;
          if (results) {
            await logger.append("INFO", `AI classified a batch of ${chunk.length} Indeed listing(s) (1 AI credit).`);
          } else {
            await logger.append("WARN", `AI classification response for a batch of ${chunk.length} listing(s) wasn't in the expected shape — treating this batch as unclassified.`);
          }
        } catch (err) {
          await logger.append("WARN", `AI job-provider classification failed: ${err.message} — this and any remaining candidate listing(s) will be saved unclassified for the rest of this run.`);
          classificationUnavailable = true;
        }
      }

      for (let j = 0; j < chunk.length; j++) {
        const post = chunk[j];
        const result = results ? results[j] : null; // null = unclassified -> fail open

        if (result && result.isJobProvider === false) {
          for (const entry of post.entries) {
            await logger.append("INFO", `Skipped a job-seeker/non-employer Indeed listing for role '${entry.roleToAssign}': ${result.reasoning || "reads like the author is looking for work, not offering it"}`);
          }
          continue; // never reaches finalizeAndInsertListing — reject before spending anything
        }

        const description = result && result.isJobProvider ? result.description : null;
        for (const entry of post.entries) {
          await finalizeAndInsertListing(entry, description);
        }
      }
    }
  }
}

async function processJob(job) {
  const { user_id } = job.data;

  const { data: roleDefs, error: roleDefsErr } = await supabase.from("automailsend_role_defs").select("*").eq("user_id", user_id);
  if (roleDefsErr) {
    console.error(pc.red(`[JobSpy Worker] Failed to load role defs for ${user_id}: ${roleDefsErr.message}`));
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
    console.log(pc.red(`[JobSpy Worker] User ${user_id} is blocked by admin. Halting.`));
    return { inserted: 0, emails: [], phones: [] };
  }

  const logger = new ExecutionLogger(user_id, "jobspy");

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
