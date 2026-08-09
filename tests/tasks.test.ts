import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceMissingError } from "../server/config.js";
import { listAbandonedTasks, listSessionTasks } from "../server/tasks.js";

let root = "";
let tasksDir = "";
let sessionsDir = "";

const LIVE_SESSION_ID = "1a2b3c4d-5566-7788-99aa-bbccddeeff00";

function writeLiveSession(sessionId: string, cwd: string): void {
  const now = Date.now();
  fs.writeFileSync(
    path.join(sessionsDir, `${Math.floor(Math.random() * 100000)}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId,
      cwd,
      startedAt: now - 1000,
      updatedAt: now,
      status: "busy",
    }),
    "utf8",
  );
}

function writeBoard(
  dirName: string,
  tasks: Array<Partial<Record<string, unknown>>>,
): void {
  const dirPath = path.join(tasksDir, dirName);
  fs.mkdirSync(dirPath, { recursive: true });
  tasks.forEach((task, index) => {
    fs.writeFileSync(
      path.join(dirPath, `${index + 1}.json`),
      JSON.stringify({
        id: String(index + 1),
        subject: `task ${index + 1}`,
        description: "",
        activeForm: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
        ...task,
      }),
      "utf8",
    );
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-tasks-"));
  tasksDir = path.join(root, "tasks");
  sessionsDir = path.join(root, "sessions");
  fs.mkdirSync(tasksDir);
  fs.mkdirSync(sessionsDir);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("listSessionTasks", () => {
  it("matches a short session-prefixed directory against a live session by prefix", () => {
    writeLiveSession(LIVE_SESSION_ID, "/tmp/project");
    writeBoard(`session-${LIVE_SESSION_ID.slice(0, 8)}`, [
      { status: "in_progress" },
      { status: "completed" },
    ]);

    const [board] = listSessionTasks(tasksDir, sessionsDir);
    expect(board).toBeDefined();
    expect(board!.sessionKeyIsFull).toBe(false);
    expect(board!.sessionLive).toBe(true);
    expect(board!.tasks).toHaveLength(2);
    expect(board!.openTasks).toHaveLength(1);
  });

  it("matches a full-identifier directory against a live session directly", () => {
    writeLiveSession(LIVE_SESSION_ID, "/tmp/project");
    writeBoard(LIVE_SESSION_ID, [{ status: "pending" }]);

    const [board] = listSessionTasks(tasksDir, sessionsDir);
    expect(board!.sessionKeyIsFull).toBe(true);
    expect(board!.sessionLive).toBe(true);
  });

  it("reads both directory naming forms in one pass", () => {
    // Both shapes exist side by side on a real machine, so a reader that
    // handles only one silently loses the other's boards.
    writeBoard("session-aaaaaaaa", [{ status: "pending" }]);
    writeBoard("bbbbbbbb-1111-2222-3333-444444444444", [{ status: "pending" }]);

    const boards = listSessionTasks(tasksDir, sessionsDir);
    expect(boards).toHaveLength(2);
    expect(boards.filter((b) => b.sessionKeyIsFull)).toHaveLength(1);
    expect(boards.filter((b) => !b.sessionKeyIsFull)).toHaveLength(1);
  });

  it("marks a board whose session is not running as not live", () => {
    writeBoard("session-deadbeef", [{ status: "in_progress" }]);
    const [board] = listSessionTasks(tasksDir, sessionsDir);
    expect(board!.sessionLive).toBe(false);
  });

  it("sorts numeric task ids in creation order, not lexicographically", () => {
    writeBoard("session-aaaaaaaa", Array.from({ length: 11 }, () => ({})));
    const [board] = listSessionTasks(tasksDir, sessionsDir);
    expect(board!.tasks.map((t) => t.id)).toEqual([
      "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11",
    ]);
  });

  it("skips an unparseable task file but keeps its siblings", () => {
    const dirPath = path.join(tasksDir, "session-aaaaaaaa");
    fs.mkdirSync(dirPath);
    fs.writeFileSync(path.join(dirPath, "1.json"), '{"id":"1","subject":"kept"', "utf8");
    fs.writeFileSync(
      path.join(dirPath, "2.json"),
      JSON.stringify({ id: "2", subject: "also kept", status: "pending" }),
      "utf8",
    );

    const [board] = listSessionTasks(tasksDir, sessionsDir);
    expect(board!.tasks).toHaveLength(1);
    expect(board!.tasks[0]!.subject).toBe("also kept");
  });

  it("ignores directories whose name matches neither form, and empty boards", () => {
    writeBoard("not-a-session-name!", [{ status: "pending" }]);
    fs.mkdirSync(path.join(tasksDir, "session-cccccccc"));
    expect(listSessionTasks(tasksDir, sessionsDir)).toEqual([]);
  });

  it("treats every board as abandoned when there is no session registry at all", () => {
    // A machine with no live-sessions directory cannot confirm anything live.
    // Reporting every board as abandoned is the honest answer, and it must not
    // take the pillar down.
    writeBoard("session-aaaaaaaa", [{ status: "pending" }]);
    const absent = path.join(root, "no-sessions-here");
    const boards = listSessionTasks(tasksDir, absent);
    expect(boards).toHaveLength(1);
    expect(boards[0]!.sessionLive).toBe(false);
  });

  it("names the missing tasks directory rather than returning an empty list", () => {
    const absent = path.join(root, "no-tasks-here");
    expect(() => listSessionTasks(absent, sessionsDir)).toThrow(SourceMissingError);
    try {
      listSessionTasks(absent, sessionsDir);
    } catch (err) {
      expect((err as SourceMissingError).sourcePath).toBe(absent);
      expect((err as SourceMissingError).pillar).toBe("tasks dir");
    }
  });
});

describe("listAbandonedTasks", () => {
  it("returns only boards with open work whose session is gone", () => {
    writeLiveSession(LIVE_SESSION_ID, "/tmp/project");

    // Live session with open work: still being worked, not abandoned.
    writeBoard(`session-${LIVE_SESSION_ID.slice(0, 8)}`, [{ status: "in_progress" }]);
    // Dead session, all work finished: nothing was dropped.
    writeBoard("session-11111111", [{ status: "completed" }]);
    // Dead session with open work: this is the one worth surfacing.
    writeBoard("session-22222222", [
      { status: "completed" },
      { status: "pending" },
      { status: "in_progress" },
    ]);

    const abandoned = listAbandonedTasks(tasksDir, sessionsDir);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]!.sessionKey).toBe("22222222");
    expect(abandoned[0]!.openTasks).toHaveLength(2);
    expect(abandoned[0]!.tasks).toHaveLength(3);
  });
});
