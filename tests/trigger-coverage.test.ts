import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceMissingError } from "../server/config.js";
import { invokedCommands, triggerCoverage } from "../server/trigger-coverage.js";

/** Synthetic only; never a captured transcript. */

let root = "";

function bashTurn(uuid: string, command: string, timestamp = "2026-08-01T10:00:00Z") {
  return {
    type: "assistant",
    uuid,
    timestamp,
    cwd: "/tmp/demo",
    message: {
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "tool_use", id: `t-${uuid}`, name: "Bash", input: { command } }],
    },
  };
}

function writeSession(sessionId: string, lines: unknown[]): void {
  const dir = path.join(root, "-tmp-demo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n"),
    "utf8",
  );
}

function rowFor(id: string) {
  const row = triggerCoverage(root).rows.find((candidate) => candidate.id === id);
  if (!row) throw new Error(`no probe row for ${id}`);
  return row;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-trigger-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("invokedCommands", () => {
  it("reads the head of each segment a shell would run", () => {
    expect(invokedCommands("git commit -m 'x'")).toEqual(["git"]);
    expect(invokedCommands("cd /tmp && cargo build")).toEqual(["cd", "cargo"]);
    expect(invokedCommands("cat log | grep error")).toEqual(["cat", "grep"]);
  });

  it("does not count a command that was only mentioned", () => {
    // The measured false-positive class: fifteen commands referred to
    // `git commit` without running it. A mention is not an invocation.
    expect(invokedCommands('echo "git commit -S -s"')).toEqual(["echo"]);
    expect(invokedCommands("grep -rn 'git commit' scripts/")).toEqual(["grep"]);
    expect(invokedCommands('rg "cargo build" .')).toEqual(["rg"]);
  });

  it("does not count commands written inside a heredoc body", () => {
    const command = [
      "cat > run.sh <<'EOF'",
      "git commit -S -s -m 'from the generated script'",
      "cargo build --release",
      "EOF",
    ].join("\n");
    expect(invokedCommands(command)).toEqual(["cat"]);
  });

  it("steps over environment assignments and wrappers", () => {
    expect(invokedCommands("FOO=1 BAR=2 docker ps")).toEqual(["docker"]);
    expect(invokedCommands("sudo kubectl get pods")).toEqual(["kubectl"]);
    expect(invokedCommands("PORT=1 nohup python3 app.py")).toEqual(["python3"]);
  });

  it("reduces a path to the script's own name", () => {
    expect(invokedCommands("~/.claude/scripts/pii-scan.sh --staged")).toEqual([
      "pii-scan.sh",
    ]);
  });

  it("keeps an operator inside quotes from splitting a segment", () => {
    expect(invokedCommands(`echo "a && b"`)).toEqual(["echo"]);
  });
});

describe("triggerCoverage", () => {
  it("names the path when there are no transcripts", () => {
    expect(() => triggerCoverage(path.join(root, "absent"))).toThrow(SourceMissingError);
  });

  it("counts occurrences and the sessions they happened in", () => {
    writeSession("s1", [bashTurn("a1", "chezmoi apply"), bashTurn("a2", "chezmoi diff")]);
    writeSession("s2", [bashTurn("b1", "chezmoi status")]);

    const row = rowFor("chezmoi");
    expect(row.bucket).toBe("triggered");
    expect(row.occurrences).toBe(3);
    expect(row.sessions).toBe(2);
    expect(row.lastSeenAt).not.toBeNull();
  });

  it("marks a rule whose trigger never occurred as a deletion candidate", () => {
    writeSession("s1", [bashTurn("a1", "python3 script.py")]);

    expect(rowFor("rust").bucket).toBe("never-triggered");
    expect(rowFor("rust").occurrences).toBe(0);
    expect(rowFor("python").bucket).toBe("triggered");
  });

  it("does not mark a rule never-triggered when no transcript could show it", () => {
    writeSession("s1", [bashTurn("a1", "python3 script.py")]);

    const row = rowFor("hash-capture");
    expect(row.bucket).toBe("not-observable");
    expect(row.occurrences).toBe(0);
    expect(row.why).toMatch(/keystroke/);
  });

  it("keeps a mention out of the counts end to end", () => {
    // Same guard as the unit test, but through the whole pillar, because this
    // is the property the report's credibility rests on.
    writeSession("s1", [bashTurn("a1", "grep -rn 'cargo build' notes.md")]);

    expect(rowFor("rust").bucket).toBe("never-triggered");
  });

  it("counts a tool probe from the recorded tool name", () => {
    writeSession("s1", [
      {
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-08-01T10:00:00Z",
        message: {
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "tool_use", id: "t1", name: "WebFetch", input: {} }],
        },
      },
    ]);

    expect(rowFor("web-research").occurrences).toBe(1);
  });

  it("refuses to report an adherence figure", () => {
    writeSession("s1", [bashTurn("a1", "git status")]);
    const result = triggerCoverage(root);

    expect(result.adherenceReported).toBe(false);
    // Nothing in the payload may be a rate: a percentage over these rows would
    // be a compliance claim the evidence cannot support.
    expect(JSON.stringify(result)).not.toMatch(/percent|rate|adherenceScore/i);
  });

  it("does not read a session older than the window", () => {
    writeSession("old", [bashTurn("a1", "kubectl get pods")]);
    const stale = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(root, "-tmp-demo", "old.jsonl"), stale, stale);

    const result = triggerCoverage(root, { windowDays: 30 });
    expect(result.sessionsScanned).toBe(0);
    expect(result.rows.find((r) => r.id === "kubernetes")!.bucket).toBe("never-triggered");
    expect(result.windowDays).toBe(30);
  });

  it("puts triggered rules first and not-observable last", () => {
    writeSession("s1", [bashTurn("a1", "docker ps")]);
    const buckets = triggerCoverage(root).rows.map((row) => row.bucket);
    const firstNotObservable = buckets.indexOf("not-observable");
    const lastTriggered = buckets.lastIndexOf("triggered");

    expect(lastTriggered).toBeLessThan(firstNotObservable);
  });
});
