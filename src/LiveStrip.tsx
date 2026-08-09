import { useEffect, useState } from "react";
import { apiGet, SourceMissing } from "./api";

type LiveSession = {
  pid: number;
  sessionId: string;
  cwd: string;
  name: string;
  kind: string;
  version: string;
  status: string;
  uptimeMs: number;
  heartbeatAgeMs: number;
  processAlive: boolean;
  live: boolean;
};

function shortenPath(cwd: string): string {
  // The last two segments identify a repository without spending a whole line on
  // the path to it.
  const parts = cwd.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}

function humanDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Which Claude sessions are running right now, as a strip above the main view.
 *
 * It earns its place at the top of every page because of what it prevents: two
 * agents working one checkout. Before launching a skill headlessly into a
 * repository, the operator can see whether an interactive session already owns
 * it, which is the difference between a clean run and a rebase landing on
 * somebody else's commit.
 */
export function LiveStrip() {
  const [sessions, setSessions] = useState<LiveSession[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      // Never cached: this is the one route whose whole point is that it changed
      // since last time, and a remembered payload would freeze the strip.
      apiGet<LiveSession[]>("/api/live", { cache: false })
        .then((rows) => {
          if (!cancelled) setSessions(rows);
        })
        .catch((err) => {
          if (cancelled) return;
          // A machine with no session registry gets no strip at all rather than an
          // error banner on every page; this is ambient context, not a pillar.
          if (err instanceof SourceMissing) setUnavailable(true);
          else setSessions([]);
        });
    };
    load();
    // Liveness is the one thing here that changes on its own, so it is polled.
    // Thirty seconds is frequent enough to catch a session opening and far too
    // slow to matter for a readdir of a handful of small files.
    const timer = window.setInterval(load, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  if (unavailable || sessions === null) return null;

  const live = sessions.filter((s) => s.live);
  const stale = sessions.filter((s) => !s.live);
  if (live.length === 0 && stale.length === 0) return null;

  return (
    <div className="live-strip">
      <span className="row-meta">
        {live.length} session{live.length === 1 ? "" : "s"} open
      </span>
      {live.map((session) => (
        <span
          key={`${session.pid}-${session.sessionId}`}
          className="live-chip is-live"
          title={`${session.cwd}\npid ${session.pid} - ${session.kind} - Claude Code ${session.version}`}
        >
          <span className="pulse">&bull;</span>
          {shortenPath(session.cwd)}
          <span className="row-meta">{session.status}</span>
          <span className="row-meta">{humanDuration(session.uptimeMs)}</span>
        </span>
      ))}
      {stale.map((session) => (
        <span
          key={`${session.pid}-${session.sessionId}`}
          className="live-chip is-stale"
          title={
            session.processAlive
              ? `${session.cwd}\nprocess ${session.pid} is alive but has not written a heartbeat for ` +
                `${humanDuration(session.heartbeatAgeMs)}, so it is treated as ended - pids get reused`
              : `${session.cwd}\nprocess ${session.pid} is gone; this registration was left behind`
          }
        >
          {shortenPath(session.cwd)}
          <span className="row-meta">ended</span>
        </span>
      ))}
    </div>
  );
}
