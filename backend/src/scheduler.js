const pc = require("picocolors");
const { supabase } = require("./config/supabase");
const { processJob } = require("./workers/scraper.worker");
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
}

module.exports = { startScheduler };
