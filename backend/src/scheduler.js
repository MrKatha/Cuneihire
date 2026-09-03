const pc = require("picocolors");
const { supabase } = require("./config/supabase");
const { processJob } = require("./workers/scraper.worker");
const { processJob: processJobSpyJob } = require("./workers/jobspy.worker");
const { runAutomailJobs } = require("./workers/automail.worker");

const { processBatchSendJob } = require("./workers/batchSend.worker");
const { processReplyPollJob } = require("./workers/replyPoll.worker");
const { runFollowUpJobs } = require("./workers/followUp.worker");
const { getGlobalSettings } = require("./lib/globalSettings");

const lastQueuedMap = new Map();

async function checkBatchSends() {
  // Debugging log to see the actual state in the database
  const { data: debugUsers } = await supabase.from("automailsend_app_state").select("user_id, batch_send_pending, batch_send_processing");
  if (debugUsers && debugUsers.length > 0) {
    console.log(pc.dim(`  -> DB State for debug: pending=${debugUsers[0].batch_send_pending}, processing=${debugUsers[0].batch_send_processing}`));
  }

  const { data: users, error } = await supabase
    .from("automailsend_app_state")
    .select("*")
    .eq("batch_send_pending", true)
    .eq("batch_send_processing", false);

  if (error) {
    console.error(pc.red(`[Scheduler] Error fetching batch send users: ${error.message}`));
    return;
  }
  
  console.log(pc.dim(`  -> Result: Found ${users ? users.length : 0} pending batch jobs.`));

  for (const user of users || []) {
    console.log(pc.cyan(`✨ [Scheduler] Triggering manual batch send for user ${user.user_id.split('-')[0]}...`));
    
    // Mark as processing
    await supabase.from("automailsend_app_state")
      .update({ batch_send_processing: true })
      .eq("user_id", user.user_id);
    
    // Bypass Redis completely to prevent infinite hangs
    processBatchSendJob({ data: user }).catch(err => {
       console.error(pc.red(`[Scheduler/Worker] Batch send failed: ${err.message}`));
    });
  }
}

function startScheduler() {
  const tickSec = process.env.SCHEDULER_INTERVAL_SEC ? parseInt(process.env.SCHEDULER_INTERVAL_SEC, 10) : 10;
  console.log(pc.green(`🚀 Starting Auto-Apply Scheduler (checking every ${tickSec} seconds)...`));

  const automailTickSec = process.env.AUTOMAIL_WORKER_INTERVAL_SEC ? parseInt(process.env.AUTOMAIL_WORKER_INTERVAL_SEC, 10) : 10;
  console.log(pc.green(`🚀 Starting Automail Worker (checking every ${automailTickSec} seconds)...`));
  let isAutomailRunning = false;
  setInterval(async () => {
    if (isAutomailRunning) return;
    isAutomailRunning = true;
    console.log(pc.dim(`[Automail Worker] Checking for pending background emails...`));
    try {
      await runAutomailJobs(supabase);
    } catch (err) {
      console.error(pc.red(`[Scheduler] Automail worker error: ${err.message}`));
    } finally {
      isAutomailRunning = false;
    }
  }, automailTickSec * 1000);

  const batchTickSec = process.env.BATCH_INTERVAL_SEC ? parseInt(process.env.BATCH_INTERVAL_SEC, 10) : 10;
  console.log(pc.green(`🚀 Starting Batch Send Worker (checking every ${batchTickSec} seconds)...`));
  let isBatchRunning = false;
  setInterval(async () => {
    if (isBatchRunning) return;
    isBatchRunning = true;
    console.log(pc.dim(`[BatchSend Worker] Checking for pending manual batches...`));
    try {
      await checkBatchSends();
    } catch (err) {
      console.error(pc.red(`[Scheduler] Batch Send error: ${err.message}`));
    } finally {
      isBatchRunning = false;
    }
  }, batchTickSec * 1000);

  const replyPollTickSec = process.env.REPLY_POLL_INTERVAL_SEC ? parseInt(process.env.REPLY_POLL_INTERVAL_SEC, 10) : 300;
  console.log(pc.green(`🚀 Starting Reply Poll Worker (checking every ${replyPollTickSec} seconds)...`));
  let isReplyPollRunning = false;
  setInterval(async () => {
    if (isReplyPollRunning) return;
    isReplyPollRunning = true;
    console.log(pc.dim(`[ReplyPoll Worker] Checking IMAP-enabled mailboxes for replies...`));
    try {
      await processReplyPollJob(supabase);
    } catch (err) {
      console.error(pc.red(`[Scheduler] Reply poll worker error: ${err.message}`));
    } finally {
      isReplyPollRunning = false;
    }
  }, replyPollTickSec * 1000);

  // Automated follow-ups (2026-08-31, MVP push) — 5th independent loop, same shape as the 4 above. 300s
  // default (day-granularity feature, no need for tight polling like automail's 10s).
  const followUpTickSec = process.env.FOLLOWUP_WORKER_INTERVAL_SEC ? parseInt(process.env.FOLLOWUP_WORKER_INTERVAL_SEC, 10) : 300;
  console.log(pc.green(`🚀 Starting Follow-Up Worker (checking every ${followUpTickSec} seconds)...`));
  let isFollowUpRunning = false;
  setInterval(async () => {
    if (isFollowUpRunning) return;
    isFollowUpRunning = true;
    console.log(pc.dim(`[FollowUp Worker] Checking for recipients due a follow-up...`));
    try {
      await runFollowUpJobs(supabase);
    } catch (err) {
      console.error(pc.red(`[Scheduler] Follow-up worker error: ${err.message}`));
    } finally {
      isFollowUpRunning = false;
    }
  }, followUpTickSec * 1000);

  setInterval(async () => {
    // or just log it so the user knows it's checking.
    console.log(pc.dim(`[Scheduler] Checking for users due for scraping...`));

    const { data: users, error } = await supabase
      .from("automailsend_app_state")
      .select("*")
      .eq("auto_fetch_enabled", true);

    if (error) {
      console.error(pc.red(`[Scheduler] Error fetching users: ${error.message}`));
      return;
    }

    if (!users || users.length === 0) {
      console.log(pc.dim(`[Scheduler] No active users with auto_fetch_enabled=true found.`));
      return;
    }

    for (const user of users) {
      try {
          const globalSettings = await getGlobalSettings();
          let intervalMin = user.auto_fetch_interval_min || 5;
          intervalMin = Math.max(intervalMin, globalSettings.min_fetch_interval || 5);
        
        // Fetch last execution for this user
        const { data: logs } = await supabase
          .from("automailsend_execution_logs")
          .select("created_at")
          .eq("user_id", user.user_id)
          .contains("details", { jobType: "scraper" })
          .order("created_at", { ascending: false })
          .limit(1);

        let shouldRun = true;
        
        if (logs && logs.length > 0) {
          const lastExecTime = new Date(logs[0].created_at).getTime();
          const now = new Date().getTime();
          const diffMin = (now - lastExecTime) / (1000 * 60);
          
          if (diffMin < intervalMin) {
            shouldRun = false;
            const remaining = intervalMin - diffMin;
            // Only log if we are close to running or just checking to avoid too much spam, but the user requested it.
            console.log(pc.yellow(`[Scheduler] User ${user.user_id.split('-')[0]}... skipping. ${remaining.toFixed(1)}m remaining.`));
          }
        }

        // Check local memory throttle (prevent infinite loop while waiting for DB insert)
        const lastQueued = lastQueuedMap.get(user.user_id) || 0;
        const nowMs = new Date().getTime();
        // Prevent queuing the exact same user more than once every 60 seconds locally
        if (nowMs - lastQueued < 60000) {
          shouldRun = false; 
        }

        if (shouldRun) {
          lastQueuedMap.set(user.user_id, nowMs);

          // IMPORTANT: Bypass Redis/BullMQ entirely by executing the worker directly in the Node process.
          // This prevents infinite hangs on Windows machines that do not have a local Redis server running.
          console.log(pc.cyan(`✨ [Scheduler] Triggering job for user ${user.user_id.split('-')[0]}... (interval reached)`));

          processJob({ data: user }).catch(err => {
             console.error(pc.red(`[Scheduler/Worker] Job failed: ${err.message}`));
          });
        }
      } catch (err) {
        console.error(pc.red(`[Scheduler] Failed to process user ${user.user_id}: ${err.message}`));
      }
    }
  }, tickSec * 1000);

  // Open-source job sourcing via JobSpy/Indeed (2026-08-31) — 6th independent loop, its own local
  // queued-throttle map so the two loops' per-user timing never interferes. A much longer default interval
  // than LinkedIn's (60min vs. a 180min *floor* but often-tighter real usage) — Indeed's own listings don't
  // change minute-to-minute the way a LinkedIn feed does, and being a good citizen against Indeed's own rate
  // limits matters since JobSpy has no official API contract with them. See docs/architecture.md's
  // "Open-source job sourcing" section.
  //
  // 2026-09-03: promoted from an opt-in per-user toggle (with a Settings UI switch) to an always-on backend
  // detail — `jobspy_sourcing_enabled` now defaults true and every existing row is backfilled (see
  // supabase_setup.sql); there's no frontend control for it any more, by operator decision ("the user does
  // not need to know what is happening in the backend"). This env var remains the one real kill switch —
  // now set true in production too (flipped live 2026-09-03, verified via `pm2 logs` showing this loop
  // start) — kept as a code-level boundary in case a fast rollback is ever needed, not as a staging-only gate.
  if (process.env.JOBSPY_SOURCING_ENABLED_GLOBALLY !== "true") {
    console.log(pc.dim("[Scheduler] JobSpy/Indeed worker not started — JOBSPY_SOURCING_ENABLED_GLOBALLY is not set in this environment."));
    return;
  }
  const jobspyTickSec = process.env.JOBSPY_SCHEDULER_INTERVAL_SEC ? parseInt(process.env.JOBSPY_SCHEDULER_INTERVAL_SEC, 10) : 60;
  const jobspyIntervalMin = process.env.JOBSPY_INTERVAL_MIN ? parseInt(process.env.JOBSPY_INTERVAL_MIN, 10) : 60;
  console.log(pc.green(`🚀 Starting JobSpy/Indeed Worker (checking every ${jobspyTickSec} seconds, ${jobspyIntervalMin}min between runs per user)...`));
  const lastJobSpyQueuedMap = new Map();
  setInterval(async () => {
    console.log(pc.dim(`[Scheduler] Checking for users due for Indeed job sourcing...`));

    const { data: users, error } = await supabase
      .from("automailsend_app_state")
      .select("*")
      .eq("jobspy_sourcing_enabled", true);

    if (error) {
      console.error(pc.red(`[Scheduler] Error fetching JobSpy-enabled users: ${error.message}`));
      return;
    }
    if (!users || users.length === 0) return;

    for (const user of users) {
      try {
        const { data: logs } = await supabase
          .from("automailsend_execution_logs")
          .select("created_at")
          .eq("user_id", user.user_id)
          .contains("details", { jobType: "jobspy" })
          .order("created_at", { ascending: false })
          .limit(1);

        let shouldRun = true;
        if (logs && logs.length > 0) {
          const diffMin = (Date.now() - new Date(logs[0].created_at).getTime()) / (1000 * 60);
          if (diffMin < jobspyIntervalMin) shouldRun = false;
        }

        const lastQueued = lastJobSpyQueuedMap.get(user.user_id) || 0;
        if (Date.now() - lastQueued < 60000) shouldRun = false;

        if (shouldRun) {
          lastJobSpyQueuedMap.set(user.user_id, Date.now());
          console.log(pc.cyan(`✨ [Scheduler] Triggering JobSpy/Indeed search for user ${user.user_id.split('-')[0]}... (interval reached)`));
          processJobSpyJob({ data: user }).catch(err => {
            console.error(pc.red(`[Scheduler/Worker] JobSpy job failed: ${err.message}`));
          });
        }
      } catch (err) {
        console.error(pc.red(`[Scheduler] Failed to process JobSpy job for user ${user.user_id}: ${err.message}`));
      }
    }
  }, jobspyTickSec * 1000);
}

module.exports = { startScheduler };
