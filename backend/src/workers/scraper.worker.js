const pc = require("picocolors");
const axios = require("axios");
const { supabase } = require("../config/supabase");
const { extractContactsWithAttribution, extractInitialContacts, extractPaginatedContacts } = require("../services/extraction.service");
const { scoreJobMatch } = require("../services/ai.service");
const { ExecutionLogger } = require("../lib/logger");
const { getGlobalSettings } = require("../lib/globalSettings");
const { spendAiCredit } = require("../lib/aiCredits");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A role is worth scoring against if it has any real criteria set — an all-'any'/empty role has nothing
// for the AI to check, so posts found for it just stay unscored (shown in JAMS as "no criteria set", never
// a fake 0). Mirrors ai.service.js's buildRoleCriteriaBlock/buildExcludeKeywordsBlock/
// buildAiInstructionsBlock field-by-field — a role with only exclude keywords or AI instructions set (and
// every structured field left "any") still needs scoring, since those two are themselves real filtering
// criteria (2026-08-25).
function roleHasCriteria(role) {
  if (!role) return false;
  return Boolean(
    (Array.isArray(role.work_modes) && role.work_modes.length > 0) ||
    (Array.isArray(role.employment_types) && role.employment_types.length > 0) ||
    (Array.isArray(role.company_sizes) && role.company_sizes.length > 0) ||
    (role.visa_sponsorship && role.visa_sponsorship !== "any") ||
    role.salary_min != null ||
    role.salary_max != null ||
    (Array.isArray(role.preferred_locations) && role.preferred_locations.length > 0) ||
    (Array.isArray(role.exclude_keywords) && role.exclude_keywords.length > 0) ||
    (role.ai_instructions && role.ai_instructions.trim())
  );
}

// `mappings` (a flat [{keyword, role, roleDef}, ...] list, one entry per keyword/alias across all of the
// user's roles) is resolved by processJob() before this is called — see automailsend_role_defs.keywords.
// Platform-managed AI (2026-08-18): `aiEnabled`/`aiCredits` (from automailsend_app_state) drive JAMS match
// scoring — scoring is skipped entirely, and the scrape proceeds exactly as before, when AI personalization
// isn't enabled or credits are exhausted. `aiTemperature` (the AI tab) feeds scoreJobMatch's Gemini call.
async function processJobLogic(job, logger, mappings, aiEnabled, aiCredits, aiTemperature) {
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

  let headers;
  try {
    headers = typeof auto_fetch_raw_headers === 'string' 
      ? JSON.parse(auto_fetch_raw_headers) 
      : auto_fetch_raw_headers;
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
      .select("id, match_analyzed_at")
      .single();
    if (error) {
      await logger.append("WARN", `Failed to upsert job post (${sourceUrl.slice(0, 60)}...): ${error.message}`);
      jobPostIdCache.set(sourceUrl, null);
      return null;
    }
    // needsScoring stays true across this whole run until a scoring attempt actually succeeds (see
    // saveContacts below) — a transient AI failure should be retried on the *next* scrape run, not
    // permanently marked "analyzed" with no score.
    const entry = { id: data.id, needsScoring: !data.match_analyzed_at };
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
      const newEmails = group.emails.filter(e => !allEmails.has(e.toLowerCase()));
      const newPhones = group.phones.filter(p => !allPhones.has(p));
      if (newEmails.length === 0 && newPhones.length === 0) continue;

      const newContactsToInsert = [];
      const maxLength = Math.max(newEmails.length, newPhones.length);
      for (let i = 0; i < maxLength; i++) {
        newContactsToInsert.push({ email: newEmails[i] || null, phone: newPhones[i] || null });
      }

      const jobPost = await getJobPost(group.source_url, group.contextText, group.authorName);
      const jobPostId = jobPost ? jobPost.id : null;

      // JAMS match scoring — once per newly-seen post, only when AI is configured and the role
      // actually has criteria worth checking (see docs/memory.md's "Job matching" section).
      let matchFields = {};
      if (jobPost && jobPost.needsScoring && aiEnabled && remainingCredits > 0 && roleHasCriteria(roleDef)) {
        try {
          const match = await scoreJobMatch(group.contextText, group.source_url, roleDef, aiTemperature);
          const spent = await spendAiCredit(supabase, user_id);
          remainingCredits = spent ? remainingCredits - 1 : 0;
          if (match) {
            matchFields = {
              match_score: match.score,
              match_reasoning: match.reasoning,
              match_analyzed_at: new Date().toISOString(),
            };
            await supabase.from("automailsend_job_posts").update(matchFields).eq("id", jobPostId);
            jobPost.needsScoring = false;
            await logger.append("INFO", `Scored job post ${match.score}/100 against role '${roleToAssign}': ${match.reasoning}`);
          }
        } catch (err) {
          await logger.append("WARN", `Job match scoring failed for ${group.source_url}: ${err.message}`);
        }
      } else if (jobPost && jobPost.needsScoring && aiEnabled && !aiCreditsExhaustedLogged) {
        await logger.append("WARN", `Out of AI credits — job posts won't be scored for the rest of this run.`);
        aiCreditsExhaustedLogged = true;
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
      
      const globalSettings = await getGlobalSettings();
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
    .select("is_blocked, ai_personalization_enabled, ai_credits, ai_temperature")
    .eq("user_id", user_id)
    .single();

  if (userState && userState.is_blocked) {
    console.log(pc.red(`[Scraper Worker] User ${user_id} is blocked by admin. Halting.`));
    return { inserted: 0, emails: [], phones: [] };
  }

  const logger = new ExecutionLogger(user_id, "scraper");

  try {
    await logger.start(`Execution started for ${mappings.length} keyword(s) across ${roleDefs.length} role(s)`);
    const result = await processJobLogic(job, logger, mappings, !!userState?.ai_personalization_enabled, userState?.ai_credits || 0, userState?.ai_temperature);
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
