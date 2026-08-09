import { useEffect, useState } from "react";
import { apiGet } from "../api";
import { FailureState, Skeleton } from "../PillarState";

type TaskRecord = {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: string;
  blocks: string[];
  blockedBy: string[];
};

type SessionTasks = {
  dirName: string;
  sessionKey: string;
  sessionKeyIsFull: boolean;
  sessionLive: boolean;
  mtimeMs: number;
  tasks: TaskRecord[];
  openTasks: TaskRecord[];
};

function statusBadge(status: string): string {
  if (status === "completed") return "badge success";
  if (status === "in_progress") return "badge spark";
  if (status === "pending") return "badge warn";
  return "badge purple";
}

function whenChanged(mtimeMs: number): string {
  if (!mtimeMs) return "unknown";
  const days = Math.floor((Date.now() - mtimeMs) / 86400000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

export function TasksView() {
  const [boards, setBoards] = useState<SessionTasks[] | null>(null);
  const [abandonedOnly, setAbandonedOnly] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setBoards(null);
    apiGet<SessionTasks[]>(`/api/tasks${abandonedOnly ? "?abandoned=true" : ""}`)
      .then((rows) => {
        setBoards(rows);
        setError(null);
      })
      .catch(setError);
  }, [abandonedOnly]);

  // The heading stays even when the source is absent: a bare panel leaves the
  // reader unable to tell which pillar they are looking at.
  const header = (
    <>
      <h1 className="view-title">
        Unfinished <span className="accent">Work</span>
      </h1>
      <p className="view-sub">
        tasks left pending when a session ended - the question none of the other
        pillars can answer
      </p>
    </>
  );

  if (error) {
    return (
      <div>
        {header}
        <FailureState error={error} />
      </div>
    );
  }

  const openTotal = (boards ?? []).reduce((sum, b) => sum + b.openTasks.length, 0);

  return (
    <div>
      {header}

      <div className="toolbar">
        <button
          className={`chip${abandonedOnly ? " active" : ""}`}
          onClick={() => setAbandonedOnly(true)}
        >
          abandoned only
        </button>
        <button
          className={`chip${abandonedOnly ? "" : " active"}`}
          onClick={() => setAbandonedOnly(false)}
        >
          every board
        </button>
        {boards && (
          <span className="row-meta">
            {boards.length} board{boards.length === 1 ? "" : "s"}, {openTotal} open
            task{openTotal === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {boards === null && <Skeleton kind="rows" count={4} label="reading task boards..." />}
      {boards !== null && boards.length === 0 && (
        <div className="empty-state">
          {abandonedOnly
            ? "nothing was left unfinished - every closed session finished its tasks"
            : "no task boards on this machine yet"}
        </div>
      )}

      {boards?.map((board) => (
        <div className="card" key={board.dirName}>
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span className={board.sessionLive ? "badge success" : "badge warn"}>
              {board.sessionLive ? "session running" : "session ended"}
            </span>
            <span className="row-meta">{board.sessionKey}</span>
            {!board.sessionKeyIsFull && (
              <span
                className="row-meta"
                title="this board's directory carries only a shortened session identifier, so it is matched by prefix"
              >
                (short id)
              </span>
            )}
            <span className="row-meta">{whenChanged(board.mtimeMs)}</span>
            <span className="row-meta">
              {board.openTasks.length} of {board.tasks.length} open
            </span>
          </div>

          <table className="data-table" style={{ marginTop: 10 }}>
            <tbody>
              {board.tasks.map((task) => (
                <tr key={task.id}>
                  <td style={{ width: 40 }} className="num-cell">
                    {task.id}
                  </td>
                  <td style={{ width: 110 }}>
                    <span className={statusBadge(task.status)}>{task.status}</span>
                  </td>
                  <td>
                    <div>{task.subject}</div>
                    {task.blockedBy.length > 0 && (
                      <div className="row-meta">blocked by {task.blockedBy.join(", ")}</div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
