import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "@/lib/supabase";
import { toast } from "react-hot-toast";

interface ExecutionLog {
  id: string;
  user_id: string;
  status: string;
  message: string;
  details: any;
  created_at: string;
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
                 toast.success(`Scraper found ${newEmails} new emails and ${newPhones} new phones!`);
               }
            } else if (updatedLog.status === "error") {
               const label = updatedLog.details?.jobType === "automail" ? "Automail" : "Scraper";
               toast.error(`${label} execution failed!`);
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

  // Countdown Timer Logic
  useEffect(() => {
    if (!intervalMin || logs.length === 0) return;
    
    const latestLog = logs[0];
    if (latestLog.status === 'running') {
      setTimeLeft("Running right now...");
      return;
    }

    const timer = setInterval(() => {
      const lastExecTime = new Date(latestLog.created_at).getTime();
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

  const getStatusClass = (status: string) => {
    switch (status.toLowerCase()) {
      case "running":
        return "text-[var(--accent)]";
      case "success":
        return "text-[var(--ok)]";
      case "error":
        return "text-[var(--danger)]";
      default:
        return "text-[var(--muted)]";
    }
  };

  return (
    <section className="panel">
      <div className="panel-head" style={{ flexWrap: 'wrap', gap: '1rem' }}>
        <div>
           <h2>Background Execution Logs</h2>
           {intervalMin && logs.length > 0 && (
             <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.25rem' }}>
               <span>Interval: {intervalMin}m</span> &bull; 
               <span style={{ marginLeft: '0.5rem' }}>Next Run: <strong style={{color: 'var(--ink)'}}>{timeLeft}</strong></span>
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
          {loading && page === 0 ? "Refreshing..." : "Refresh Logs"}
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
            No execution logs found yet.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginTop: '1rem' }}>
            {logs.map((log, index) => (
              <LogItem 
                key={log.id} 
                log={log} 
                getStatusClass={getStatusClass} 
                lastElementRef={index === logs.length - 1 ? lastElementRef : null} 
              />
            ))}
            {loading && page > 0 && (
              <p className="hint" style={{ textAlign: 'center', padding: '1rem 0' }}>Loading older logs...</p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function LogItem({ log, getStatusClass, lastElementRef }: any) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = log.details && Object.keys(log.details).length > 0;

  return (
    <div 
      ref={lastElementRef}
      style={{ 
        padding: '0.75rem', 
        backgroundColor: 'var(--bg-elevated)', 
        border: '1px solid var(--line)', 
        borderRadius: '6px' 
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
        <span className={getStatusClass(log.status)} style={{ fontWeight: 600, fontSize: '0.75rem', textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: '6px' }}>
          {log.status === "running" && (
            <svg className="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
          )}
          {log.details?.jobType ? `[${log.details.jobType.toUpperCase()}] ${log.status}` : log.status}
        </span>
        <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
          {new Date(log.created_at).toLocaleString()}
        </span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
        <p style={{ fontSize: '0.85rem', fontFamily: 'monospace', color: 'var(--ink)', margin: 0, flex: 1 }}>
          {log.message}
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
        <div style={{ marginTop: '0.5rem', padding: '0.75rem', backgroundColor: 'var(--bg-body)', borderRadius: '6px' }}>
          {log.details.logs && Array.isArray(log.details.logs) && (
            <div style={{ marginBottom: '0.75rem' }}>
              <strong style={{ fontSize: '0.75rem', color: 'var(--ink)', display: 'block', marginBottom: '0.5rem' }}>
                Terminal Output:
              </strong>
              <pre style={{ 
                backgroundColor: '#1e1e1e', 
                color: '#d4d4d4', 
                padding: '0.75rem', 
                borderRadius: '4px', 
                fontSize: '0.75rem', 
                maxHeight: '300px', 
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                margin: 0
              }}>
                {log.details.logs.map((line: string, i: number) => {
                  let color = '#d4d4d4';
                  if (line.includes('[ERROR]')) color = '#f87171'; // red
                  else if (line.includes('[WARN]')) color = '#fbbf24'; // yellow
                  else if (line.includes('[SUCCESS]')) color = '#4ade80'; // green
                  else if (line.includes('[INFO]')) color = '#60a5fa'; // blue
                  
                  return <div key={i} style={{ color, marginBottom: '2px', fontFamily: 'monospace' }}>{line}</div>;
                })}
              </pre>
            </div>
          )}

          {log.details.new_emails && Array.isArray(log.details.new_emails) && log.details.new_emails.length > 0 && (
            <div style={{ marginBottom: '0.75rem' }}>
              <strong style={{ fontSize: '0.75rem', color: 'var(--ink)', display: 'block', marginBottom: '0.25rem' }}>
                📧 New Emails ({log.details.new_emails.length}):
              </strong>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {log.details.new_emails.map((e: string, i: number) => (
                  <span key={i} className="badge ok" style={{ fontSize: '0.7rem' }}>{e}</span>
                ))}
              </div>
            </div>
          )}
          
          {log.details.new_phones && Array.isArray(log.details.new_phones) && log.details.new_phones.length > 0 && (
            <div style={{ marginBottom: '0.75rem' }}>
              <strong style={{ fontSize: '0.75rem', color: 'var(--ink)', display: 'block', marginBottom: '0.25rem' }}>
                📞 New Phones ({log.details.new_phones.length}):
              </strong>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {log.details.new_phones.map((p: string, i: number) => (
                  <span key={i} className="badge warn" style={{ fontSize: '0.7rem' }}>{p}</span>
                ))}
              </div>
            </div>
          )}

          {/* Fallback for completely different log structures */}
          {(!log.details.logs && !log.details.new_emails && !log.details.new_phones) && (
            <div style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'var(--muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {JSON.stringify(log.details, null, 2)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
