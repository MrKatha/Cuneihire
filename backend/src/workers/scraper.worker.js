const pc = require("picocolors");
const axios = require("axios");
const { supabase } = require("../config/supabase");
const { extractContactsWithAttribution, extractInitialContacts, extractPaginatedContacts } = require("../services/extraction.service");
const { scoreJobMatch, generateMatchKeywords, matchKeywordsAreStale } = require("../services/ai.service");
const { roleHasCriteria, computeAlgorithmicMatch, shouldEscalateToAI } = require("../services/matchAlgorithm.service");
const { ExecutionLogger } = require("../lib/logger");
const { getGlobalSettings } = require("../lib/globalSettings");
const { spendAiCredit } = require("../lib/aiCredits");
const { decryptPassword } = require("../lib/crypto");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// True when roleDef has real, USABLE (non-stale, non-empty) AI-curated match keywords — the gate that lets
// shouldEscalateToAI stop forcing a full AI read on every post for an ai_instructions role (2026-08-28
// follow-up). Lives here, not matchAlgorithm.service.js, so that file can stay dependency-free (it imports
// nothing from ai.service.js) even though matchKeywordsAreStale itself happens to be pure.
function hasFreshMatchKeywords(roleDef) {
  if (!roleDef.ai_instructions || !roleDef.ai_instructions.trim()) return false;
  if (matchKeywordsAreStale(roleDef)) return false;
  return (roleDef.match_keywords_positive || []).length > 0 || (roleDef.match_keywords_negative || []).length > 0;
}

// `mappings` (a flat [{keyword, role, roleDef}, ...] list, one entry per keyword/alias across all of the
// user's roles) is resolved by processJob() before this is called — see automailsend_role_defs.keywords.
// Platform-managed AI (2026-08-18): `aiEnabled`/`aiCredits` (from automailsend_app_state) drive JAMS match
// scoring — scoring is skipped entirely, and the scrape proceeds exactly as before, when AI personalization
// isn't enabled or credits are exhausted. `aiTemperature` (the AI tab) feeds scoreJobMatch's Gemini call.
// `matchStrictness` (also the AI tab, same automailsend_app_state.ai_match_strictness automail.worker.js
// already reads) now also gates HERE, not just at send time — see saveContacts below (2026-08-28).
async function processJobLogic(job, logger, mappings, aiEnabled, aiCredits, aiTemperature, matchStrictness) {
  const {
    user_id,
    auto_fetch_raw_headers,
    auto_fetch_pagination_limit,
    auto_fetch_pagination_delay_sec,
    post_age_filter,
  } = job.data;

  // We have keywords, so we can now initialize the logger and safely use it
  await logger.append("INFO", `Starting auto-apply fetch for ${mappings.length} keywords`);

  // Local mutable tracker — multiple posts can get scored in one run, each spending one credit.
  let remainingCredits = aiCredits || 0;
  let aiCreditsExhaustedLogged = false;

  // Hoisted here (2026-08-28) — used to already be fetched later, inside the pagination branch, only for
  // maxPages/delayMs. saveContacts (defined below) also needs it now, for the algorithmic-match escalation
  // thresholds. getGlobalSettings() is 60s-cached, so calling it once up front costs nothing extra.
  const globalSettings = await getGlobalSettings();

  // AI-curated match keywords (2026-08-28 follow-up) — generates once per role, not once per post, so an
  // ai_instructions role stops costing a full AI read on every single scraped post. Capped at one attempt
  // per role PER RUN (role.id -> failed) — a role whose generation fails (AI error, or credits ran out)
  // gets retried fresh on the next run, not spammed across every keyword/page for that same role in this
  // one. Declared at this scope (not inside saveContacts) since saveContacts is called multiple times per
  // run (once per keyword's initial + each paginated page) and this cap needs to span all of them.
  const matchKeywordsAttemptFailed = new Set();
  const ensureMatchKeywords = async (roleDef) => {
    if (!roleDef.ai_instructions || !roleDef.ai_instructions.trim()) return; // nothing to translate
    if (!matchKeywordsAreStale(roleDef)) return; // already fresh — this run or a prior one
    if (matchKeywordsAttemptFailed.has(roleDef.id)) return;
    if (!aiEnabled || !(remainingCredits > 0)) return; // same gates as the full-post escalation path

    try {
      const generated = await generateMatchKeywords(roleDef, aiTemperature, user_id);
      const spent = await spendAiCredit(supabase, user_id);
      remainingCredits = spent ? remainingCredits - 1 : 0;
      if (!generated) {
        matchKeywordsAttemptFailed.add(roleDef.id);
        return;
      }
      const fields = {
        match_keywords_positive: generated.positive,
        match_keywords_negative: generated.negative,
        match_keywords_source_snapshot: generated.promptSnapshot,
        match_keywords_generated_at: new Date().toISOString(),
      };
      await supabase.from("automailsend_role_defs").update(fields).eq("id", roleDef.id);
      // Mutate the SHARED roleDef object in place (mappings' entries all reference the same object per
      // role, never cloned — see processJob) so every later keyword/group for this role in this run sees
      // the fresh keywords immediately, no extra cache map needed.
      Object.assign(roleDef, fields);
      if (generated.positive.length === 0 && generated.negative.length === 0) {
        await logger.append(
          "INFO",
          `AI instructions for role '${roleDef.key}' couldn't be reduced to literal keywords — will keep using full AI reads per post for this role (cached, won't re-attempt until the instructions change).`
        );
      } else {
        await logger.append(
          "INFO",
          `Generated AI match keywords for role '${roleDef.key}': ${generated.positive.length} positive, ${generated.negative.length} negative (1 AI credit, cached for future scrapes).`
        );
      }
    } catch (err) {
      matchKeywordsAttemptFailed.add(roleDef.id);
      await logger.append("WARN", `Failed to generate AI match keywords for role '${roleDef.key}': ${err.message} — full AI reads continue for now, will retry next run.`);
    }
  };

  let headers;
  try {
    // auto_fetch_raw_headers may be "enc:"-prefixed ciphertext (foundation-hardening pass, 2026-08-31
    // follow-up — this blob is the real LinkedIn session credential, was plaintext at rest before this)
    // or still a plain JSON string for a row that hasn't been re-saved since. decryptPassword() passes
    // non-"enc:"-prefixed text through unchanged, so this is safe either way.
    const rawHeadersPlain = typeof auto_fetch_raw_headers === 'string'
      ? decryptPassword(auto_fetch_raw_headers)
      : auto_fetch_raw_headers;
    headers = typeof rawHeadersPlain === 'string'
      ? JSON.parse(rawHeadersPlain)
      : rawHeadersPlain;
    await logger.append("SUCCESS", "Parsed Headers Successfully");
  } catch (err) {
    await logger.append("ERROR", `Failed to parse raw headers: ${err.message}`);
    throw new Error(`Failed to parse raw headers: ${err.message}`);
  }

  const allEmails = new Set();
  const allPhones = new Set();
  let totalInserted = 0;
  const successfullyInsertedEmails = [];
  const successfullyInsertedPhones = [];

  await logger.append("INFO", "Fetching existing contacts from DB to prevent duplicates...");
  const { data: existingData } = await supabase
    .from('automailsend_recipients')
    .select('email, phone')
    .eq('user_id', user_id);
    
  if (existingData) {
    existingData.forEach(row => {
      if (row.email) allEmails.add(row.email.toLowerCase());
      if (row.phone) allPhones.add(row.phone);
    });
  }

  const { data: sentLogData } = await supabase
    .from('automailsend_sent_log')
    .select('email')
    .eq('user_id', user_id);
    
  if (sentLogData) {
    sentLogData.forEach(row => {
      if (row.email) allEmails.add(row.email.toLowerCase());
    });
  }
  
  await logger.append("SUCCESS", `Loaded ${allEmails.size} emails and ${allPhones.size} phones to skip (including sent log).`);

  // Cache of source_url -> { id, needsScoring } for this run, so the same post (seen again across
  // pagination pages or keywords) isn't re-upserted or re-scored on every group.
  const jobPostIdCache = new Map();
  const getJobPost = async (sourceUrl, contextText, authorName) => {
    if (!sourceUrl) return null;
    if (jobPostIdCache.has(sourceUrl)) return jobPostIdCache.get(sourceUrl);
    // Only include author_name in the upsert when we actually resolved one — a later pass that
    // failed to resolve an owner (e.g. the legacy fallback path, which never does) must not blank
    // out an author_name a previous, more successful pass already saved for this same post.
    const { data, error } = await supabase
      .from("automailsend_job_posts")
      .upsert(
        { user_id, source_url: sourceUrl, context_text: contextText || null, ...(authorName ? { author_name: authorName } : {}) },
        { onConflict: "user_id,source_url" }
      )
      .select("id, match_analyzed_at, match_score, match_reasoning, match_source")
      .single();
    if (error) {
      await logger.append("WARN", `Failed to upsert job post (${sourceUrl.slice(0, 60)}...): ${error.message}`);
      jobPostIdCache.set(sourceUrl, null);
      return null;
    }
    // needsScoring stays true across this whole run until a scoring attempt actually succeeds (see
    // saveContacts below) — a transient AI failure should be retried on the *next* scrape run, not
    // permanently marked "analyzed" with no score. matchScore/matchReasoning/matchSource carry forward an
    // already-scored post's result (from this run or a prior one) so a later-arriving new contact on
    // the same post can still be gated without re-spending a credit to re-score it.
    const entry = {
      id: data.id,
      needsScoring: !data.match_analyzed_at,
      matchScore: data.match_score ?? null,
      matchReasoning: data.match_reasoning ?? null,
      matchSource: data.match_source ?? null,
    };
    jobPostIdCache.set(sourceUrl, entry);
    return entry;
  };

  // `groups` is a list of { emails, phones, source_url, contextText, authorName } — each group is a
  // contact (or small cluster of contacts) already correctly attributed to ONE specific post (or null
  // if the owning post couldn't be determined). See extraction.service.js's extractContactsWithAttribution.
  // `keyword` is the search term that found this group — used as a stand-in job title (see below).
  // `roleDef` is the full role row (not just the key) — needed to score this post against its rules.
  const saveContacts = async (groups, roleToAssign, keyword, roleDef) => {
    for (const group of groups) {
      // Dedup FIRST, before spending anything (2026-08-28, operator ask — checking "does this contact
      // already exist" needs to happen as early as possible, before an AI credit is spent, not after).
      // A group with nothing new in it costs nothing: no job-post upsert, no scoring call, no credit.
      const newEmails = group.emails.filter(e => !allEmails.has(e.toLowerCase()));
      const newPhones = group.phones.filter(p => !allPhones.has(p));
      if (newEmails.length === 0 && newPhones.length === 0) continue;

      // Resolve + score the job post only once we know there's actually something new to potentially
      // insert. This DOES mean a post whose every contact was already captured before AI matching
      // existed stays unscored by the live scraper going forward too — that's fine, since there's
      // nothing left for a fresh score to change (nothing new to reject or insert). Catching up that
      // kind of historical debt is a one-time backfill job, not something worth re-attempting on every
      // single live run forever (see backend/backfill_match_scores.tmp.js in scratchpad).
      const jobPost = await getJobPost(group.source_url, group.contextText, group.authorName);
      const jobPostId = jobPost ? jobPost.id : null;
      let matchScore = jobPost ? jobPost.matchScore : null;
      let matchReasoning = jobPost ? jobPost.matchReasoning : null;

      // JAMS match scoring (2026-08-28, Phase 2 task 1 — operator ask: "work on the algorithm first,"
      // AI supplements it rather than being the sole engine). The deterministic algorithm always runs
      // first, for free — a post only gets an actual Gemini call when the algorithm itself can't resolve
      // it confidently (see matchAlgorithm.service.js's shouldEscalateToAI). Seeded from a prior run's
      // score/source when there is one, so a contact that only shows up on an already-scored post still
      // gets that denormalized onto its own recipient row below.
      let matchSource = jobPost ? jobPost.matchSource : null;
      let matchFields = matchScore != null ? { match_score: matchScore, match_reasoning: matchReasoning, match_source: matchSource } : {};

      const applyMatchResult = async (score, reasoning, source, algoResult) => {
        matchFields = {
          match_score: score,
          match_reasoning: reasoning,
          match_source: source,
          match_analyzed_at: new Date().toISOString(),
          ...(algoResult ? { match_algo_score: algoResult.score, match_algo_reasoning: algoResult.reasoning } : {}),
        };
        await supabase.from("automailsend_job_posts").update(matchFields).eq("id", jobPostId);
        jobPost.needsScoring = false;
        matchScore = score;
        matchReasoning = reasoning;
        matchSource = source;
      };

      if (jobPost && jobPost.needsScoring && roleHasCriteria(roleDef)) {
        await ensureMatchKeywords(roleDef);
        const algoResult = computeAlgorithmicMatch(group.contextText, roleDef);
        const escalate = shouldEscalateToAI(algoResult, roleDef, {
          aiEnabled,
          remainingCredits,
          lowThreshold: globalSettings.algo_match_escalate_low ?? 20,
          highThreshold: globalSettings.algo_match_escalate_high ?? 80,
          hasFreshMatchKeywords: hasFreshMatchKeywords(roleDef),
        });

        if (escalate) {
          try {
            const match = await scoreJobMatch(group.contextText, group.source_url, roleDef, aiTemperature, user_id);
            const spent = await spendAiCredit(supabase, user_id);
            remainingCredits = spent ? remainingCredits - 1 : 0;
            if (match) {
              await applyMatchResult(match.score, match.reasoning, "ai", algoResult);
              await logger.append(
                "INFO",
                `Scored (AI) ${match.score}/100 for role '${roleToAssign}'${algoResult ? ` (algorithm said ${algoResult.score})` : ""}: ${match.reasoning}`
              );
            } else if (algoResult) {
              await applyMatchResult(algoResult.score, algoResult.reasoning, "algorithm", algoResult);
            }
          } catch (err) {
            // AI failure now falls back to the algorithmic score instead of leaving the post fully
            // unscored (2026-08-28) — a deliberate behavior change from before: an AI outage used to mean
            // every post silently bypassed the match-strictness gate for the rest of the run ("unscored
            // isn't a fail"). Now a Gemini outage still gets SOME enforcement.
            if (algoResult) {
              await applyMatchResult(algoResult.score, algoResult.reasoning, "algorithm", algoResult);
              await logger.append("WARN", `AI match scoring failed for ${group.source_url}, used the algorithmic score ${algoResult.score} instead: ${err.message}`);
            } else {
              await logger.append("WARN", `Job match scoring failed for ${group.source_url}: ${err.message}`);
            }
          }
        } else if (algoResult) {
          await applyMatchResult(algoResult.score, algoResult.reasoning, "algorithm", algoResult);
          await logger.append("INFO", `Scored (algorithm, 0 AI credits) ${algoResult.score}/100 for role '${roleToAssign}': ${algoResult.reasoning}`);
        } else if (aiEnabled && remainingCredits <= 0 && !aiCreditsExhaustedLogged) {
          // Only reachable when the role has ONLY AI-only criteria set (company_sizes/ai_instructions/
          // visa_sponsorship) and credits are exhausted — everything else now gets an algorithmic score
          // regardless of credits.
          await logger.append("WARN", `Out of AI credits — posts needing AI-only judgment (free-text AI instructions, company size, visa sponsorship) won't be scored for the rest of this run.`);
          aiCreditsExhaustedLogged = true;
        }
      }

      // Enforce the match, don't just record it (2026-08-28, operator ask — "if the job does not match
      // the description I mentioned, do not get that job at all"). Reuses the same ai_match_strictness
      // threshold automail.worker.js already gates sends on, just moved earlier: a post scored below it
      // never becomes a recipient in the first place, instead of sailing through as "pending" and only
      // maybe getting caught at send time. Same "unscored is never a fail" convention as everywhere else
      // in this codebase (no score yet, or strictness left at 0/off, means nothing is rejected here).
      if (matchScore != null && matchStrictness > 0 && matchScore < matchStrictness) {
        await logger.append(
          "INFO",
          `Not saving ${newEmails.length + newPhones.length} contact(s) — job post scored ${matchScore}/100 for role '${roleToAssign}' (below your ${matchStrictness} threshold): ${matchReasoning || "no reasoning given"}`
        );
        continue;
      }

      const newContactsToInsert = [];
      const maxLength = Math.max(newEmails.length, newPhones.length);
      for (let i = 0; i < maxLength; i++) {
        newContactsToInsert.push({ email: newEmails[i] || null, phone: newPhones[i] || null });
      }

      await logger.append("INFO", `Inserting ${newContactsToInsert.length} new record(s) into Supabase for role '${roleToAssign}'...`);
      for (const entry of newContactsToInsert) {
        const emailToInsert = entry.email ? entry.email.toLowerCase() : "";
        const phoneToInsert = entry.phone || "";
        const { error } = await supabase.from("automailsend_recipients").insert({
          user_id,
          email: emailToInsert,
          phone: phoneToInsert,
          role: roleToAssign,
          // Auto-fetched contacts used to always get title: "" — the {{title}} template placeholder
          // was silently blank for every scraped contact. The search keyword that found them is the
          // closest available proxy for "job title" (e.g. keyword "DevOps Engineer" -> role DevOps).
          title: keyword || "",
          source: "auto_fetch",
          job_post_id: jobPostId,
          context_text: group.contextText || null,
          source_url: group.source_url || null,
          // Denormalized from the job post (like context_text/source_url already are) so sending
          // doesn't need a join — see extraction.service.js's authorName / docs/memory.md.
          author_name: group.authorName || null,
          // Denormalized JAMS match fields (same reasoning) — empty object when not scored this pass.
          ...matchFields,
          scraped_at: new Date().toISOString(),
          status: "pending",
        });
        if (error) {
           await logger.append("ERROR", `Supabase insert error: ${error.message}`);
        } else {
           totalInserted++;
           if (emailToInsert) {
             allEmails.add(emailToInsert);
             successfullyInsertedEmails.push(emailToInsert);
           }
           if (phoneToInsert) {
             allPhones.add(phoneToInsert);
             successfullyInsertedPhones.push(phoneToInsert);
           }
        }
      }
    }
  };

  // Try the per-post-attributed extractor first; fall back to the legacy page-level one (and wrap its
  // single aggregate result as one group) if the page didn't match the expected wire format.
  const resolveContactGroups = async (rawText, legacyExtractor, label) => {
    const attributed = extractContactsWithAttribution(rawText);
    if (attributed) {
      if (attributed.groups.length === 0) {
        await logger.append("INFO", `${label}: parsed ${attributed.postsFound} post(s), no contacts found in them.`);
      }
      return attributed.groups;
    }
    await logger.append("WARN", `${label}: page didn't match the expected format, falling back to page-level extraction (post attribution won't be available for these contacts).`);
    const legacy = legacyExtractor(rawText);
    if (legacy.emails.length === 0 && legacy.phones.length === 0) return [];
    // Legacy extraction never resolves per-post ownership, so it can't know an author either.
    return [{ emails: legacy.emails, phones: legacy.phones, source_url: legacy.source_urls || null, contextText: legacy.contextText || null, authorName: null }];
  };

  for (const mapping of mappings) {
    const currentKeyword = mapping.keyword;
    const currentRole = mapping.role;
    const currentRoleDef = mapping.roleDef;

    await logger.append("INFO", `Searching for keyword: "${currentKeyword}" (Role: ${currentRole})`);

    const keywordsQuery = encodeURIComponent(currentKeyword);
    const searchBase = process.env.LINKEDIN_SEARCH_BASE_URL || "https://www.linkedin.com/search/results/content/";
    let searchUrl = `${searchBase}?keywords=${keywordsQuery}&origin=SWITCH_SEARCH_VERTICAL`;
    
    if (post_age_filter && post_age_filter !== 'any') {
      searchUrl += `&datePosted=%22${encodeURIComponent(post_age_filter)}%22`;
    }

    await logger.append("INFO", `Fetching Initial Search Page for "${currentKeyword}"...`);
    let response;
    try {
      response = await axios.get(searchUrl, { headers, responseType: 'text' });
    } catch (err) {
      const errorDetails = err.response ? `HTTP ${err.response.status}` : err.message;
      await logger.append("ERROR", `Search request failed for "${currentKeyword}": ${errorDetails}`);
      continue; // Skip to next keyword
    }

    const rawText = response.data;
    await logger.append("SUCCESS", `Initial Search Page Loaded (HTTP ${response.status}) [${rawText.length} bytes]`);

    await logger.append("INFO", `Extracting Contacts from Initial Page for "${currentKeyword}"...`);
    const initialGroups = await resolveContactGroups(rawText, extractInitialContacts, "Initial page");
    const initialEmails = initialGroups.flatMap(g => g.emails);
    const initialPhones = initialGroups.flatMap(g => g.phones);
    let initialDetails = "";
    if (initialEmails.length > 0) initialDetails += ` [Emails: ${initialEmails.join(", ")}]`;
    if (initialPhones.length > 0) initialDetails += ` [Phones: ${initialPhones.join(", ")}]`;
    await logger.append("SUCCESS", `Initial Page Found: ${initialEmails.length} emails, ${initialPhones.length} phones${initialDetails}`);

    await saveContacts(initialGroups, currentRole, currentKeyword, currentRoleDef);

    // Extract Pagination info
    let raw = rawText.replace(/\\+"/g, '"').replace(/&quot;/g, '"');
    const searchId = (raw.match(/"searchId"\s*:\s*"([0-9a-fA-F-]{36})"/) || [])[1];
    
    if (!searchId) {
      await logger.append("WARN", `No searchId found, cannot paginate for "${currentKeyword}".`);
    } else {
      const rawKeywords = ((raw.match(/"keywords"\s*:\s*"((?:\\.|[^"\\])*)"/) || [])[1] || currentKeyword).replace(/\\"/g, '"');
      let startIndex = Number((raw.match(/"startIndex"\s*:\s*(\d+)/) || [])[1] || 12);
      const count = Number((raw.match(/"count"\s*:\s*(\d+)/) || [])[1] || 3);
      let clusterStartPosition = Number((raw.match(/"clusterStartPosition"\s*:\s*(\d+)/) || [])[1] || 9);
      
      let maxPages = auto_fetch_pagination_limit || 1;
      maxPages = Math.min(maxPages, globalSettings.max_pagination_limit || 10);

      const defaultInterval = process.env.SCRAPER_INTERVAL_SEC ? parseInt(process.env.SCRAPER_INTERVAL_SEC, 10) : 10;
      let delayMs = (auto_fetch_pagination_delay_sec || defaultInterval) * 1000;
      delayMs = Math.max(delayMs, (globalSettings.min_pagination_delay || 5) * 1000);

      await logger.append("INFO", `Pagination details found for "${currentKeyword}". Max Pages: ${maxPages}, Delay: ${delayMs/1000}s`);

      for (let page = 1; page <= maxPages; page++) {
        await logger.append("INFO", `Fetching page ${page} of ${maxPages}... (waiting ${delayMs/1000}s)`);
        await sleep(delayMs);

        const payload = {
          startIndex,
          keywords: rawKeywords,
          count,
          sortBy: [],
          postedBy: [],
          datePosted: post_age_filter && post_age_filter !== 'any' ? [post_age_filter] : [],
          contentType: [],
          fromMember: [],
          mentionsOrganization: [],
          mentionsMember: [],
          fromOrganization: [],
          authorCompany: [],
          authorIndustry: [],
          authorJobTitle: [],
          spellCheckEnabled: true,
          clusterStartPosition,
          searchId,
        };

        const body = {
          pagerId: 'com.linkedin.sdui.search.contentSearchResults',
          clientArguments: {
            $type: 'proto.sdui.actions.requests.RequestedArguments',
            requestedStateKeys: [],
            payload,
            requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
            states: [],
            screenId: 'com.linkedin.sdui.flagshipnav.search.SearchResultsContent',
          },
          paginationRequest: {
            $type: 'proto.sdui.actions.requests.PaginationRequest',
            pagerId: 'com.linkedin.sdui.search.contentSearchResults',
            trigger: {
              $case: 'itemDistanceTrigger',
              itemDistanceTrigger: {
                $type: 'proto.sdui.actions.requests.ItemDistanceTrigger',
                preloadDistance: 3,
                preloadLength: 1500,
              },
            },
            retryCount: 2,
            requestedArguments: {
              $type: 'proto.sdui.actions.requests.RequestedArguments',
              requestedStateKeys: [],
              payload: {
                ...payload,
                startIndex: startIndex + count,
                clusterStartPosition: clusterStartPosition + 2,
              },
              requestMetadata: { $type: 'proto.sdui.common.RequestMetadata' },
            },
          },
        };

        await logger.append("INFO", `Executing POST pagination request for page ${page}`);
        try {
          const paginationUrl = process.env.LINKEDIN_PAGINATION_URL || "https://www.linkedin.com/flagship-web/rsc-action/actions/pagination";
          const paginatedRes = await axios.post(`${paginationUrl}?sduiid=com.linkedin.sdui.search.contentSearchResults`, body, {
            headers: {
              ...headers,
              "Content-Type": "application/json"
            },
            responseType: 'text'
          });

          const paginatedText = paginatedRes.data;

          const paginatedGroups = await resolveContactGroups(paginatedText, extractPaginatedContacts, `Page ${page}`);
          const paginatedEmails = paginatedGroups.flatMap(g => g.emails);
          const paginatedPhones = paginatedGroups.flatMap(g => g.phones);

          let paginatedDetails = "";
          if (paginatedEmails.length > 0) paginatedDetails += ` [Emails: ${paginatedEmails.join(", ")}]`;
          if (paginatedPhones.length > 0) paginatedDetails += ` [Phones: ${paginatedPhones.join(", ")}]`;
          await logger.append("SUCCESS", `Page ${page} Found: ${paginatedEmails.length} emails, ${paginatedPhones.length} phones${paginatedDetails}`);

          await saveContacts(paginatedGroups, currentRole, currentKeyword, currentRoleDef);

        } catch (err) {
          const errorDetails = err.response ? `HTTP ${err.response.status}` : err.message;
          await logger.append("ERROR", `Paginated request error: ${errorDetails}`);
        }

        startIndex += count;
        clusterStartPosition += 2;
      }
    }
  }

  if (totalInserted === 0) {
    await logger.append("WARN", "No new records to insert.");
  } else {
    await logger.append("SUCCESS", `Total Unique Contacts Inserted: ${totalInserted}`);
  }

  return { inserted: totalInserted, emails: successfullyInsertedEmails, phones: successfullyInsertedPhones };
}

async function processJob(job) {
  const { user_id } = job.data;

  // Keywords now live per-role (automailsend_role_defs.keywords) instead of a single app_state blob —
  // resolve the flat mapping list here, before creating a logger, so a user with zero keywords across
  // every role still skips silently (same "don't flood logs" behavior as before). Full row (`select("*")`,
  // not just key/keywords) so JAMS match scoring has the role's rules (work_mode, salary, etc.) to check
  // scraped posts against — see ai.service.js's scoreJobMatch.
  const { data: roleDefs, error: roleDefsErr } = await supabase
    .from("automailsend_role_defs")
    .select("*")
    .eq("user_id", user_id);

  if (roleDefsErr) {
    console.error(pc.red(`[Scraper Worker] Failed to load role defs for ${user_id}: ${roleDefsErr.message}`));
    return { inserted: 0, emails: [], phones: [] };
  }

  const mappings = (roleDefs || []).flatMap((d) =>
    (d.keywords || []).map((keyword) => ({ keyword, role: d.key, roleDef: d }))
  );

  if (mappings.length === 0) {
    return { inserted: 0, emails: [], phones: [] };
  }

  const { data: userState } = await supabase
    .from("automailsend_app_state")
    .select("is_blocked, ai_personalization_enabled, ai_credits, ai_temperature, ai_match_strictness")
    .eq("user_id", user_id)
    .single();

  if (userState && userState.is_blocked) {
    console.log(pc.red(`[Scraper Worker] User ${user_id} is blocked by admin. Halting.`));
    return { inserted: 0, emails: [], phones: [] };
  }

  const logger = new ExecutionLogger(user_id, "scraper");

  try {
    await logger.start(`Execution started for ${mappings.length} keyword(s) across ${roleDefs.length} role(s)`);
    const result = await processJobLogic(job, logger, mappings, !!userState?.ai_personalization_enabled, userState?.ai_credits || 0, userState?.ai_temperature, userState?.ai_match_strictness || 0);
    const detailsObj = { new_emails: result.emails, new_phones: result.phones };
    await logger.finish("success", `Execution finished. Inserted ${result.inserted} new unique records.`, detailsObj);
    return result;
  } catch (err) {
    const errorDetails = { stack: err.stack, name: err.name };
    await logger.finish("error", `Execution failed: ${err.message}`, errorDetails);
    throw err;
  }
}

module.exports = { processJob };
