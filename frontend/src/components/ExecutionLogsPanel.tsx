import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { toast } from "react-hot-toast";

type ExecutionLogDetails = {
  jobType?: string;
  logs?: string[];
  new_emails?: string[];
  new_phones?: string[];
  [key: string]: unknown;
};

interface ExecutionLog {
  id: string;
  user_id: string;
  status: string;
  message: string;
  details: ExecutionLogDetails | null;
  created_at: string;
}

// What each background job actually is, in plain language — the raw `jobType` values
// ("scraper"/"jobspy"/"automail"/"follow_up"/"reply_poll") come straight from each worker file's own
// `new ExecutionLogger(userId, "...")` call (backend/src/workers/*.worker.js), a developer-facing id, not
// something written for a candidate to read.
const JOB_TYPE_LABELS: Record<string, string> = {
  scraper: "LinkedIn search",
  jobspy: "Job board search",
  automail: "Sending emails",
  follow_up: "Sending follow-ups",
  reply_poll: "Checking for replies",
};

function jobTypeLabel(jobType?: string) {
  if (!jobType) return "Background task";
  return JOB_TYPE_LABELS[jobType] || jobType.replace(/_/g, " ");
}

const STATUS_LABELS: Record<string, string> = {
  running: "In progress",
  success: "Completed",
  error: "Failed",
};

function statusLabel(status: string) {
  return STATUS_LABELS[status.toLowerCase()] || status;
}

function statusColor(status: string) {
  switch (status.toLowerCase()) {
    case "running":
      return "var(--accent)";
    case "success":
      return "var(--ok)";
    case "error":
      return "var(--danger)";
    default:
      return "var(--muted)";
  }
}

// Backend messages are already close to plain English (see logger.js) but a few carry over
// developer-facing words ("Execution", "batch", "unique records"). Known patterns get reworded; anything
// unrecognized (a message shape added later, say) just passes through unchanged rather than being hidden.
function humanizeMessage(message: string): string {
  const patterns: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^Execution started for (\d+) keyword\(s\) across (\d+) role\(s\)$/, (m) => `Started — searching ${m[1]} keyword(s) across ${m[2]} role(s)`],
    [/^Execution finished\. Inserted (\d+) new unique records?\.$/, (m) => `Found ${m[1]} new contact${m[1] === "1" ? "" : "s"}`],
    [/^Execution failed: (.+)$/, (m) => `Something went wrong: ${m[1]}`],
    [/^Starting Automail batch process\.\.\.$/, () => "Started sending emails…"],
    [/^Finished batch\. Sent: (\d+)$/, (m) => `Sent ${m[1]} email${m[1] === "1" ? "" : "s"}`],
    [/^Starting follow-up batch process\.\.\.$/, () => "Started sending follow-ups…"],
    [/^Finished follow-up batch\. Sent: (\d+)$/, (m) => `Sent ${m[1]} follow-up${m[1] === "1" ? "" : "s"}`],
    [/^Error fetching templates$/, () => "Couldn't load your email templates"],
  ];
  for (const [re, fn] of patterns) {
    const m = message.match(re);
    if (m) return fn(m);
  }
  return message;
}

export function ExecutionLogsPanel({ userId }: { userId: string }) {
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [intervalMin, setIntervalMin] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState<string>("Calculating...");
  const limit = 50;

  const observer = useRef<IntersectionObserver | null>(null);

  const fetchConfig = async () => {
    const { data } = await supabase.from('automailsend_app_state').select('auto_fetch_interval_min').eq('user_id', userId).single();
    if (data && data.auto_fetch_interval_min) {
      setIntervalMin(data.auto_fetch_interval_min);
    }
  };

  const fetchLogs = async (pageNum: number, overwrite = false) => {
    setLoading(true);
    const from = pageNum * limit;
    const to = from + limit - 1;

    const { data, error } = await supabase
      .from("automailsend_execution_logs")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) {
      console.error("Error fetching execution logs:", error);
    } else {
      if (data) {
        setLogs(prev => overwrite ? data : [...prev, ...data]);
        setHasMore(data.length === limit);
      }
    }
    setLoading(false);
  };

  // Initial load & real-time subscription
  useEffect(() => {
    if (!userId) return;

    fetchConfig();
    fetchLogs(0, true);

    const channel = supabase
      .channel("execution-logs-updates")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "automailsend_execution_logs",
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.eventType === "INSERT") {
            setLogs((prev) => [payload.new as ExecutionLog, ...prev]);
          } else if (payload.eventType === "UPDATE") {
            const updatedLog = payload.new as ExecutionLog;

            // Check if we should notify
            if (updatedLog.status === "success" && updatedLog.details) {
               const newEmails = updatedLog.details.new_emails?.length || 0;
               const newPhones = updatedLog.details.new_phones?.length || 0;
               if (newEmails > 0 || newPhones > 0) {
                 toast.success(`Found ${newEmails} new email(s) and ${newPhones} new phone number(s)!`);
               }
            } else if (updatedLog.status === "error") {
               const label = jobTypeLabel(updatedLog.details?.jobType);
               toast.error(`${label} failed — see Activity for details.`);
            }

            setLogs((prev) =>
              prev.map((log) => (log.id === updatedLog.id ? updatedLog : log))
            );
          } else if (payload.eventType === "DELETE") {
            setLogs((prev) => prev.filter((log) => log.id !== payload.old.id));
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId]);

  // Countdown to the next LinkedIn search (2026-09-01 fix — this used to key off `logs[0]`, the single
  // most recent log across every job type, but `intervalMin` is specifically the LinkedIn-search cadence
  // (auto_fetch_interval_min). If the latest entry happened to be an automail/follow-up/reply-check log
  // instead, the countdown silently math'd the wrong job's schedule against it — a real source of "this
  // number doesn't mean anything" confusion, not just a cosmetic one. Now scoped to the latest scraper log.
  useEffect(() => {
    if (!intervalMin) return;
    const latestScraperLog = logs.find((l) => (l.details?.jobType || "scraper") === "scraper");
    if (!latestScraperLog) return;

    if (latestScraperLog.status === 'running') {
      setTimeLeft("Running right now...");
      return;
    }

    const timer = setInterval(() => {
      const lastExecTime = new Date(latestScraperLog.created_at).getTime();
      const intervalMs = intervalMin * 60 * 1000;
      const now = new Date().getTime();

      let nextExecTime = lastExecTime + intervalMs;

      if (nextExecTime <= now) {
         const cyclesPassed = Math.ceil((now - lastExecTime) / intervalMs);
         nextExecTime = lastExecTime + (cyclesPassed * intervalMs);
      }

      const diff = nextExecTime - now;
      const m = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
      const s = Math.floor((diff % (1000 * 60)) / 1000);
      setTimeLeft(`${m}m ${s}s`);
    }, 1000);

    return () => clearInterval(timer);
  }, [logs, intervalMin]);

  const lastElementRef = useCallback(
    (node: HTMLDivElement | null) => {
      if (loading) return;
      if (observer.current) observer.current.disconnect();

      observer.current = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && hasMore) {
          const nextPage = page + 1;
          setPage(nextPage);
          fetchLogs(nextPage, false);
        }
      });

      if (node) observer.current.observe(node);
    },
    [loading, hasMore, page]
  );

  return (
    <section className="panel">
      <div className="panel-head" style={{ flexWrap: 'wrap', gap: '1rem' }}>
        <div>
           <h2>Activity</h2>
           <p className="hint compact" style={{ margin: '0.2rem 0 0' }}>What your automations have been doing.</p>
           {intervalMin && logs.length > 0 && (
             <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.35rem' }}>
               Next LinkedIn search in <strong style={{ color: 'var(--ink)' }}>{timeLeft}</strong>
             </div>
           )}
        </div>
        <button
          type="button"
          onClick={() => {
            setPage(0);
            fetchLogs(0, true);
          }}
          className="btn ghost"
          disabled={loading && page === 0}
        >
          {loading && page === 0 ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      <div
        className="panel-body"
        style={{
          maxHeight: '400px',
          overflowY: 'auto',
          scrollbarWidth: 'none', // Firefox
          msOverflowStyle: 'none' // IE/Edge
        }}
      >
        <style>{`
          .panel-body::-webkit-scrollbar {
            display: none;
          }
        `}</style>

        {logs.length === 0 && !loading ? (
          <p className="hint" style={{ textAlign: 'center', margin: '2rem 0' }}>
            Nothing yet — this fills in once your automations start running.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
            {logs.map((log, index) => (
              <LogItem
                key={log.id}
                log={log}
                lastElementRef={index === logs.length - 1 ? lastElementRef : null}
              />
            ))}
            {loading && page > 0 && (
              <p className="hint" style={{ textAlign: 'center', padding: '1rem 0' }}>Loading older activity...</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// One parsed line from `details.logs` (backend/src/lib/logger.js writes "[hh:mm:ss] [LEVEL] message").
// The raw array used to render as a dark terminal console — accurate, but the single biggest reason this
// tab read as a developer tool, not a candidate-facing activity feed. Parsed into plain rows instead.
function parseLogLine(line: string): { level: string; text: string } {
  const m = line.match(/^\[[\d:.]+\]\s*\[(\w+)\]\s*(.*)$/);
  if (!m) return { level: "INFO", text: line };
  return { level: m[1], text: m[2] };
}

function levelColor(level: string) {
  switch (level.toUpperCase()) {
    case "ERROR":
      return "var(--danger)";
    case "WARN":
      return "var(--warn)";
    case "SUCCESS":
      return "var(--ok)";
    default:
      return "var(--muted)";
  }
}

function LogItem({ log, lastElementRef }: { log: ExecutionLog; lastElementRef: ((node: HTMLDivElement | null) => void) | null }) {
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const details = log.details;
  const steps = (details?.logs || []).map(parseLogLine);
  const newEmails = details?.new_emails || [];
  const newPhones = details?.new_phones || [];
  const hasKnownDetails = steps.length > 0 || newEmails.length > 0 || newPhones.length > 0;
  const hasUnknownDetails = !hasKnownDetails && !!details && Object.keys(details).some((k) => k !== "jobType");
  const hasDetails = hasKnownDetails || hasUnknownDetails;

  return (
    <div
      ref={lastElementRef}
      style={{
        padding: '0.75rem',
        backgroundColor: 'var(--bg-elevated)',
        border: '1px solid var(--line)',
        borderRadius: '10px'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: "0.4rem", color: statusColor(log.status), fontWeight: 600, fontSize: '0.8rem' }}>
          {log.status === "running" ? (
            <svg className="animate-spin" width="10" height="10" viewBox="0 0 24 24" fill="none">
              <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          ) : (
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor(log.status), display: "inline-block" }} />
          )}
          {jobTypeLabel(log.details?.jobType)} — {statusLabel(log.status)}
        </span>
        <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
          {new Date(log.created_at).toLocaleString()}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
        <p style={{ fontSize: '0.85rem', color: 'var(--ink)', margin: 0, flex: 1, lineHeight: 1.4 }}>
          {humanizeMessage(log.message)}
        </p>
        {hasDetails && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: '0.1rem' }}
          >
            {expanded ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 15l-6-6-6 6"/></svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6"/></svg>
            )}
          </button>
        )}
      </div>
      {expanded && hasDetails && (
        <div style={{ marginTop: '0.5rem', padding: '0.75rem', backgroundColor: 'var(--bg)', borderRadius: '8px', display: "flex", flexDirection: "column", gap: "0.6rem" }}>
          {newEmails.length > 0 && (
            <div>
              <strong style={{ fontSize: '0.72rem', color: 'var(--ink)', display: 'block', marginBottom: '0.25rem' }}>
                New emails found ({newEmails.length})
              </strong>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {newEmails.map((e, i) => (
                  <span key={i} className="badge ok" style={{ fontSize: '0.7rem' }}>{e}</span>
                ))}
              </div>
            </div>
          )}

          {newPhones.length > 0 && (
            <div>
              <strong style={{ fontSize: '0.72rem', color: 'var(--ink)', display: 'block', marginBottom: '0.25rem' }}>
                New phone numbers found ({newPhones.length})
              </strong>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {newPhones.map((p, i) => (
                  <span key={i} className="badge warn" style={{ fontSize: '0.7rem' }}>{p}</span>
                ))}
              </div>
            </div>
          )}

          {steps.length > 0 && (
            <div>
              <strong style={{ fontSize: '0.72rem', color: 'var(--ink)', display: 'block', marginBottom: '0.35rem' }}>
                What happened, step by step
              </strong>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                {steps.map((s, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.4rem', fontSize: '0.76rem' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: levelColor(s.level), flexShrink: 0, marginTop: '0.35rem' }} />
                    <span style={{ color: 'var(--muted)' }}>{s.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {hasUnknownDetails && (
            <div>
              <button
                type="button"
                className="btn ghost"
                style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem' }}
                onClick={() => setShowRaw((v) => !v)}
              >
                {showRaw ? "Hide raw data" : "Show raw data"}
              </button>
              {showRaw && (
                <pre style={{ fontSize: '0.7rem', color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: '0.4rem' }}>
                  {JSON.stringify(details, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
