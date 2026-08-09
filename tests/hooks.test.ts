import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceMissingError } from "../server/config.js";
import { hookHealth } from "../server/hooks.js";

let root = "";
const PROJECT_DIR = "-tmp-demo-project";

function writeTranscript(sessionId: string, lines: unknown[]): void {
  const dirPath = path.join(root, PROJECT_DIR);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(
    path.join(dirPath, `${sessionId}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n"),
    "utf8",
  );
}

function hookSummary(
  hookInfos: Array<{ command: string; durationMs?: number }>,
  extra: Record<string, unknown> = {},
) {
  return {
    type: "system",
    uuid: `s${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "s1",
    timestamp: "2026-07-01T10:00:00.000Z",
    subtype: "stop_hook_summary",
    hookCount: hookInfos.length,
    hookInfos,
    ...extra,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-hooks-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("hookHealth", () => {
  it("groups by command and reports observed percentiles", () => {
    writeTranscript("s1", [
      hookSummary([{ command: "$HOME/.claude/scripts/nudge.sh", durationMs: 100 }]),
      hookSummary([{ command: "$HOME/.claude/scripts/nudge.sh", durationMs: 200 }]),
      hookSummary([{ command: "$HOME/.claude/scripts/nudge.sh", durationMs: 300 }]),
    ]);

    const health = hookHealth(root);
    expect(health.hooks).toHaveLength(1);
    const hook = health.hooks[0]!;
    expect(hook.label).toBe("nudge.sh");
    expect(hook.invocations).toBe(3);
    expect(hook.totalMs).toBe(600);
    expect(hook.maxMs).toBe(300);
    // Nearest-rank, so every reported figure is a duration that really happened.
    expect(hook.medianMs).toBe(200);
    expect(hook.p95Ms).toBe(300);
  });

  it("excludes a missing duration from the percentiles instead of counting it as zero", () => {
    // Counting an absent duration as 0 would drag the median down and make a slow
    // hook look fast, which is the opposite of what this pillar is for.
    writeTranscript("s1", [
      hookSummary([{ command: "slow.sh", durationMs: 400 }]),
      hookSummary([{ command: "slow.sh", durationMs: 500 }]),
      hookSummary([{ command: "slow.sh" }]),
    ]);

    const hook = hookHealth(root).hooks[0]!;
    expect(hook.invocations).toBe(3);
    expect(hook.durationsMissing).toBe(1);
    // Two observed durations, [400, 500]. Nearest-rank takes the lower of the
    // pair rather than averaging to 450, because 450 is a number no run produced.
    // What matters for the missing-duration rule is that it is not dragged toward
    // zero by the third invocation.
    expect(hook.medianMs).toBe(400);
    expect(hook.p95Ms).toBe(500);
    expect(hook.totalMs).toBe(900);
  });

  it("ranks by total cost, not by worst single run", () => {
    writeTranscript("s1", [
      hookSummary([{ command: "spiky.sh", durationMs: 900 }]),
      ...Array.from({ length: 20 }, () =>
        hookSummary([{ command: "steady.sh", durationMs: 100 }]),
      ),
    ]);

    const hooks = hookHealth(root).hooks;
    // steady.sh costs 2000 ms in total against spiky.sh's 900, so it leads even
    // though its worst run is far quicker.
    expect(hooks[0]!.label).toBe("steady.sh");
    expect(hooks[0]!.totalMs).toBe(2000);
    expect(hooks[1]!.label).toBe("spiky.sh");
  });

  it("counts error records and turns a hook blocked", () => {
    writeTranscript("s1", [
      hookSummary([{ command: "ok.sh", durationMs: 10 }]),
      hookSummary([{ command: "bad.sh", durationMs: 10 }], { hookErrors: ["exit 1"] }),
      hookSummary([{ command: "blocker.sh", durationMs: 10 }], {
        preventedContinuation: true,
      }),
    ]);

    const health = hookHealth(root);
    expect(health.errorRecords).toBe(1);
    expect(health.blockedTurns).toBe(1);
    expect(health.totalInvocations).toBe(3);
  });

  it("redacts a credential written into a hook command", () => {
    writeTranscript("s1", [
      hookSummary([
        { command: "curl -H 'Authorization: Bearer sk-LIVEcredential' https://x/y", durationMs: 5 },
      ]),
    ]);

    const hook = hookHealth(root).hooks[0]!;
    expect(hook.command).not.toContain("sk-LIVEcredential");
  });

  it("counts sessions that ran no hooks at all", () => {
    writeTranscript("s1", [hookSummary([{ command: "a.sh", durationMs: 5 }])]);
    writeTranscript("s2", [
      { type: "user", uuid: "u1", sessionId: "s2", timestamp: "2026-07-01T10:00:00.000Z" },
    ]);

    const health = hookHealth(root);
    expect(health.sessionsScanned).toBe(2);
    expect(health.sessionsWithoutHooks).toBe(1);
  });

  it("shortens an inline command that names no script", () => {
    writeTranscript("s1", [
      hookSummary([
        { command: "command -v osascript >/dev/null 2>&1 && osascript -e 'display notification' || true", durationMs: 5 },
      ]),
    ]);
    const hook = hookHealth(root).hooks[0]!;
    expect(hook.label.length).toBeLessThanOrEqual(48);
    expect(hook.label).toContain("command -v osascript");
  });

  it("counts one session per command even across many invocations", () => {
    writeTranscript("s1", [
      hookSummary([{ command: "a.sh", durationMs: 1 }]),
      hookSummary([{ command: "a.sh", durationMs: 1 }]),
    ]);
    writeTranscript("s2", [hookSummary([{ command: "a.sh", durationMs: 1 }])]);

    const hook = hookHealth(root).hooks[0]!;
    expect(hook.invocations).toBe(3);
    expect(hook.sessions).toBe(2);
  });

  it("names the missing transcripts directory rather than returning empty stats", () => {
    expect(() => hookHealth(path.join(root, "absent"))).toThrow(SourceMissingError);
  });
});
