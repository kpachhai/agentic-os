import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceMissingError } from "../server/config.js";
import { annotateAges, frictionAging, parseFrictionLog, linkResolutions } from "../server/friction.js";
import { memoryGraph } from "../server/graph.js";
import { historyStats, listPrompts } from "../server/history.js";
import { captureHookCommand, readPacing } from "../server/pacing.js";

let root = "";

/** Synthetic fixtures only; the real stores are the operator's own writing. */
function writeMemoryNote(project: string, name: string, description: string, body: string): void {
  const dir = path.join(root, "projects", project, "memory");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\nmetadata:\n  type: feedback\n---\n\n${body}\n`,
    "utf8",
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-misc-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("memoryGraph", () => {
  it("builds edges from wikilinks between notes", () => {
    writeMemoryNote("proj", "alpha", "Alpha note", "Relates to [[beta]] closely.");
    writeMemoryNote("proj", "beta", "Beta note", "Standalone content.");

    const graph = memoryGraph(path.join(root, "projects"));
    expect(graph.stats.entries).toBe(2);
    expect(graph.stats.links).toBe(1);
    const beta = graph.nodes.find((n) => n.name === "beta")!;
    expect(beta.inbound).toHaveLength(1);
    expect(beta.orphan).toBe(false);
  });

  it("does not mistake bash test syntax for a link", () => {
    // The regression this pins is severe on a real corpus: `[[ -f "$f" ]]` and
    // `[[:space:]]` appear thousands of times in notes that quote shell, and a
    // permissive pattern reported every one as a broken link - burying the real
    // ones and inventing a maintenance problem that did not exist.
    writeMemoryNote(
      "proj",
      "shell-notes",
      "Notes containing shell",
      [
        'Use `if [[ -f "$settings_file" ]]; then` to guard the read.',
        "Strip with `tr -d '[[:space:]]'` before comparing.",
        'Check `[[ -n "$left" ]]` and `[[ "$sync" == "1" ]]`.',
        "This one is a real link: [[alpha]].",
      ].join("\n"),
    );
    writeMemoryNote("proj", "alpha", "Alpha note", "Content.");

    const graph = memoryGraph(path.join(root, "projects"));
    expect(graph.stats.links).toBe(1);
    expect(graph.brokenLinks).toEqual([]);
  });

  it("reports a link to a note that does not exist as broken", () => {
    // A silently dropped link is a reference the operator believes exists.
    writeMemoryNote("proj", "alpha", "Alpha", "See [[does-not-exist]] for detail.");
    const graph = memoryGraph(path.join(root, "projects"));
    expect(graph.brokenLinks).toEqual([
      { from: "proj/alpha", target: "does-not-exist" },
    ]);
  });

  it("does not count a self-link as a connection", () => {
    // Counting it would make an isolated note look linked and hide it from the
    // orphan list, which is the list worth reading.
    writeMemoryNote("proj", "alpha", "Alpha", "As noted in [[alpha]] above.");
    const graph = memoryGraph(path.join(root, "projects"));
    expect(graph.stats.links).toBe(0);
    expect(graph.orphans).toEqual(["proj/alpha"]);
  });

  it("excludes session wraps, which are a different artifact in the same directory", () => {
    writeMemoryNote("proj", "alpha", "Alpha", "Content.");
    const dir = path.join(root, "projects", "proj", "memory");
    fs.writeFileSync(
      path.join(dir, "session_wrap_2026_01_01_thing.md"),
      "# Session Wrap: thing\n\nLinks to [[alpha]].\n",
      "utf8",
    );
    const graph = memoryGraph(path.join(root, "projects"));
    expect(graph.stats.entries).toBe(1);
    expect(graph.stats.links).toBe(0);
  });

  it("resolves a link case- and separator-insensitively", () => {
    writeMemoryNote("proj", "some-note", "Some note", "x");
    writeMemoryNote("proj", "other", "Other", "See [[Some Note]].");
    expect(memoryGraph(path.join(root, "projects")).stats.links).toBe(1);
  });

  it("names the missing source rather than returning an empty graph", () => {
    expect(() => memoryGraph(path.join(root, "absent"))).toThrow(SourceMissingError);
  });
});

describe("prompt history", () => {
  function writeHistory(entries: unknown[]): string {
    const filePath = path.join(root, "history.jsonl");
    fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n"), "utf8");
    return filePath;
  }

  it("returns prompts newest first", () => {
    const filePath = writeHistory([
      { display: "older ask", timestamp: 1000, project: "-tmp-a", sessionId: "s1", pastedContents: {} },
      { display: "newer ask", timestamp: 2000, project: "-tmp-a", sessionId: "s2", pastedContents: {} },
    ]);
    expect(listPrompts(filePath).map((p) => p.text)).toEqual(["newer ask", "older ask"]);
  });

  it("reports that a paste happened without ever returning what was pasted", () => {
    // Pasted content is the likeliest place for a secret to be sitting, and
    // nothing in this pillar needs it.
    const filePath = writeHistory([
      {
        display: "look at this",
        timestamp: 1,
        project: "-tmp-a",
        sessionId: "s1",
        pastedContents: { "1": { content: "SECRET-PASTED-VALUE" } },
      },
    ]);
    const [entry] = listPrompts(filePath);
    expect(entry!.hadPaste).toBe(true);
    expect(JSON.stringify(entry)).not.toContain("SECRET-PASTED-VALUE");
  });

  it("truncates a long prompt rather than reproducing it whole", () => {
    const filePath = writeHistory([
      { display: "x".repeat(5000), timestamp: 1, project: "-tmp-a", sessionId: "s1" },
    ]);
    expect(listPrompts(filePath)[0]!.text.length).toBeLessThan(600);
  });

  it("returns no prompt text at all from the stats route", () => {
    // The stats view is the one most likely to be left open or screenshotted, so
    // it is built to carry no content.
    const filePath = writeHistory([
      { display: "SENSITIVE-PROMPT-TEXT", timestamp: Date.parse("2026-07-01T11:00:00Z"), project: "-tmp-a", sessionId: "s1" },
    ]);
    const stats = historyStats(filePath);
    expect(JSON.stringify(stats)).not.toContain("SENSITIVE-PROMPT-TEXT");
    expect(stats.totalPrompts).toBe(1);
    expect(stats.byProject[0]!.count).toBe(1);
    expect(stats.byHour).toHaveLength(24);
  });

  it("skips a torn trailing line without failing the read", () => {
    const filePath = path.join(root, "history.jsonl");
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ display: "good", timestamp: 1, project: "p", sessionId: "s" })}\n{"display": "trunc`,
      "utf8",
    );
    expect(listPrompts(filePath)).toHaveLength(1);
  });

  it("names the missing source", () => {
    expect(() => listPrompts(path.join(root, "nope.jsonl"))).toThrow(SourceMissingError);
  });
});

describe("pacing", () => {
  function writePacing(samples: unknown[]): string {
    const filePath = path.join(root, "pacing.jsonl");
    fs.writeFileSync(filePath, samples.map((s) => JSON.stringify(s)).join("\n"), "utf8");
    return filePath;
  }

  const resetSeconds = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000);

  it("reads epoch SECONDS for a reset, not milliseconds", () => {
    // Treating the field as milliseconds puts every reset in 1970 and makes a
    // fresh window read as permanently expired.
    const filePath = writePacing([
      {
        session_id: "s1",
        model: { display_name: "Opus" },
        rate_limits: {
          five_hour: { used_percentage: 42, resets_at: resetSeconds },
          seven_day: { used_percentage: 12, resets_at: resetSeconds },
        },
      },
    ]);
    const pacing = readPacing(filePath);
    expect(pacing.current!.fiveHour!.usedPercent).toBe(42);
    expect(pacing.current!.fiveHour!.resetsAt).toBe("2026-08-01T00:00:00.000Z");
    expect(new Date(pacing.current!.fiveHour!.resetsAt).getUTCFullYear()).toBe(2026);
  });

  it("takes the newest sample that actually carries limits", () => {
    // The block only appears for subscription accounts and only after a session's
    // first API response, so the newest sample often has none - and blanking a
    // valid reading because a fresh session just started would be wrong.
    const filePath = writePacing([
      {
        session_id: "s1",
        rate_limits: { five_hour: { used_percentage: 55, resets_at: resetSeconds } },
      },
      { session_id: "s2", model: { display_name: "Opus" } },
    ]);
    const pacing = readPacing(filePath);
    expect(pacing.current!.sessionId).toBe("s1");
    expect(pacing.current!.fiveHour!.usedPercent).toBe(55);
    expect(pacing.samplesWithoutLimits).toBe(1);
    // The newest sample overall is still first in the list.
    expect(pacing.samples[0]!.sessionId).toBe("s2");
  });

  it("ignores a blob that is not a statusline sample", () => {
    // Keeps an unrelated JSON file pointed at this path from rendering as pacing.
    const filePath = writePacing([{ some: "other json" }, { session_id: "s1" }]);
    expect(readPacing(filePath).totalSamples).toBe(1);
  });

  it("leaves the capture time empty rather than stamping it as now", () => {
    // Stamping would make every historical sample look current.
    const filePath = writePacing([{ session_id: "s1" }]);
    expect(readPacing(filePath).samples[0]!.capturedAt).toBe("");
  });

  it("names the missing source, which is the default state", () => {
    // Nobody has this file until they install the hook.
    expect(() => readPacing(path.join(root, "nope.jsonl"))).toThrow(SourceMissingError);
  });

  it("returns the setup command as text rather than running it", () => {
    const setup = captureHookCommand("/tmp/x.jsonl");
    expect(setup.statusLineCommand).toContain("/tmp/x.jsonl");
    expect(setup.explanation).toMatch(/settings/i);
  });
});

describe("friction aging", () => {
  const DAY = 86_400_000;
  const now = Date.parse("2026-07-01T00:00:00Z");

  function parsed(lines: string[]) {
    const entries = parseFrictionLog(lines.join("\n"));
    linkResolutions(entries, 14);
    annotateAges(entries, now);
    return entries;
  }

  it("measures an open entry against now and a closed one against its resolution", () => {
    const entries = parsed([
      "2026-06-01T00:00:00Z | [Friction] | the axis overflowed its container",
      "2026-06-08T00:00:00Z | [Resolution] | added a compact tick formatter for the axis overflow",
      "2026-06-20T00:00:00Z | [Friction] | something still unresolved here",
    ]);
    const closed = entries.find((e) => e.status === "resolved")!;
    const open = entries.find((e) => e.status === "open")!;
    expect(closed.ageDays).toBe(7);
    expect(open.ageDays).toBe(11);
  });

  it("bands an open entry by age so a list can sort by pressure", () => {
    const entries = parsed([
      `${new Date(now - 200 * DAY).toISOString()} | [Friction] | very old unresolved thing`,
      `${new Date(now - 3 * DAY).toISOString()} | [Friction] | recent unresolved thing`,
    ]);
    const bands = entries.filter((e) => e.status === "open").map((e) => e.ageBand);
    expect(bands).toContain("stale");
    expect(bands).toContain("week");
  });

  it("leaves age unset for an unparseable date rather than reporting zero", () => {
    // Zero would read as "opened today", the opposite of what a missing date means.
    const entries = parsed(["| not-a-date | Friction | scope | text |"]);
    expect(entries.every((e) => e.ageDays === undefined)).toBe(true);
  });

  it("reports the resolution rate, oldest open age, and median time to close", () => {
    const entries = parsed([
      "2026-06-01T00:00:00Z | [Friction] | first friction about the axis overflow",
      "2026-06-03T00:00:00Z | [Resolution] | fixed the axis overflow with a formatter",
      `${new Date(now - 100 * DAY).toISOString()} | [Friction] | long running unresolved item`,
    ]);
    const aging = frictionAging(entries);
    expect(aging.openCount).toBe(1);
    expect(aging.resolvedCount).toBe(1);
    expect(aging.resolutionRate).toBeCloseTo(0.5, 6);
    expect(aging.oldestOpenDays).toBe(100);
    expect(aging.medianDaysToResolve).toBe(2);
    // Bands read oldest-first so a growing tail is visible at a glance.
    expect(aging.openByBand[0]!.band).toBe("stale");
  });
});
