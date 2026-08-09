import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceMissingError } from "../server/config.js";
import {
  BURST_MIN_WINDOW_DAYS,
  BURST_STALE_DAYS,
  STALE_DAYS,
  deletionShortlist,
  skillActivity,
  type CounterEntry,
  type SkillActivityReport,
} from "../server/skill-trend.js";

let root = "";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Synthetic transcripts only. The real tree is the operator's own session history,
 * and nothing from it belongs in a fixture. These lines carry the fields this
 * reader looks at, in the shapes the real files use.
 */
function writeTranscriptIn(
  baseDir: string,
  projectDir: string,
  sessionId: string,
  records: unknown[],
): string {
  const dir = path.join(baseDir, projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    filePath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  return filePath;
}

function writeTranscript(
  projectDir: string,
  sessionId: string,
  records: unknown[],
): string {
  return writeTranscriptIn(root, projectDir, sessionId, records);
}

/**
 * A transcript written by a dispatched subagent, which sits in a directory named for
 * the session that dispatched it rather than beside the session transcripts.
 */
function writeSubagentTranscript(
  projectDir: string,
  ownerSessionId: string,
  subagentSessionId: string,
  records: unknown[],
): string {
  return writeTranscriptIn(
    root,
    path.join(projectDir, ownerSessionId, "subagents"),
    subagentSessionId,
    records,
  );
}

/** One attributed assistant record, which is the shape attribution rides on. */
function attributed(skill: string, timestamp: string): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp,
    attributionSkill: skill,
    message: { role: "assistant", model: "some-model", content: [] },
  };
}

/** An ordinary assistant record: corpus history that carries no attribution. */
function unattributed(timestamp: string): Record<string, unknown> {
  return {
    type: "assistant",
    timestamp,
    message: { role: "assistant", model: "some-model", content: [] },
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-skill-trend-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("skillActivity", () => {
  it("counts records per skill with its span, sessions, projects and months", () => {
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      attributed("alpha-skill", "2026-01-05T10:00:00.000Z"),
      attributed("alpha-skill", "2026-01-06T10:00:00.000Z"),
      attributed("beta-skill", "2026-01-07T10:00:00.000Z"),
    ]);
    writeTranscript("-tmp-beta", "bbbbbbbb-2222-4333-8444-555555555555", [
      attributed("alpha-skill", "2026-03-09T10:00:00.000Z"),
    ]);

    const report = skillActivity(root);
    const alpha = report.skills.find((skill) => skill.name === "alpha-skill")!;
    expect(alpha.attributedRecords).toBe(3);
    expect(alpha.firstAttributedAt).toBe("2026-01-05T10:00:00.000Z");
    expect(alpha.lastAttributedAt).toBe("2026-03-09T10:00:00.000Z");
    expect(alpha.sessionsAttributed).toBe(2);
    expect(alpha.projectsAttributed).toBe(2);
    expect(alpha.months).toEqual([
      { month: "2026-01", attributedRecords: 2 },
      { month: "2026-03", attributedRecords: 1 },
    ]);
    expect(alpha.distinctMonths).toBe(2);
    expect(alpha.busiestMonth).toBe("2026-01");
    expect(report.stats.attributedRecords).toBe(4);
    expect(report.stats.skillsAttributed).toBe(2);
  });

  it("counts records produced, not turns or invocations", () => {
    // Two hundred records under one attribution is one skill doing a lot of work,
    // not two hundred separate reaches for it. The field name has to keep meaning
    // the former, because the counter already means the latter.
    const records = Array.from({ length: 200 }, (_, index) =>
      attributed("busy-skill", `2026-02-01T${String(index % 24).padStart(2, "0")}:00:00.000Z`),
    );
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", records);
    const report = skillActivity(root);
    expect(report.skills[0]!.attributedRecords).toBe(200);
    expect(report.skills[0]!.sessionsAttributed).toBe(1);
  });

  it("ignores records that carry no attribution", () => {
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      { type: "user", timestamp: "2026-01-05T10:00:00.000Z", message: { role: "user", content: "hi" } },
      { type: "assistant", timestamp: "2026-01-05T10:01:00.000Z", message: { role: "assistant", content: [] } },
      { type: "assistant", timestamp: "2026-01-05T10:02:00.000Z", attributionSkill: "" },
      attributed("real-skill", "2026-01-05T10:03:00.000Z"),
    ]);
    const report = skillActivity(root);
    expect(report.skills).toHaveLength(1);
    expect(report.stats.attributedRecords).toBe(1);
  });

  it("counts an undated record as undated rather than filing it under a fake month", () => {
    // A timestamp that is missing or not a date must not become a month key. The
    // histogram plus the undated count has to add back up to the record total, or
    // the histogram is quietly narrower than the number printed beside it.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      attributed("mixed-skill", "2026-01-05T10:00:00.000Z"),
      { type: "assistant", attributionSkill: "mixed-skill" },
      { type: "assistant", attributionSkill: "mixed-skill", timestamp: "not-a-date" },
    ]);
    const skill = skillActivity(root).skills[0]!;
    expect(skill.attributedRecords).toBe(3);
    expect(skill.recordsWithoutTimestamp).toBe(2);
    const inMonths = skill.months.reduce((sum, month) => sum + month.attributedRecords, 0);
    expect(inMonths + skill.recordsWithoutTimestamp).toBe(skill.attributedRecords);
    expect(skill.months.map((month) => month.month)).toEqual(["2026-01"]);
  });

  it("reports the window with its empty months filled in", () => {
    // A caller drawing a histogram needs the quiet months to exist; leaving them
    // out renders a gap as if it were outside the recorded window.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      attributed("a", "2026-01-31T23:00:00.000Z"),
      attributed("b", "2026-04-01T01:00:00.000Z"),
    ]);
    const report = skillActivity(root);
    expect(report.window.months).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"]);
    expect(report.window.firstAttributedAt).toBe("2026-01-31T23:00:00.000Z");
    expect(report.window.lastAttributedAt).toBe("2026-04-01T01:00:00.000Z");
    expect(report.window.spanDays).toBe(59);
  });

  it("reads the whole tree, not just the newest transcripts", () => {
    // Bounding the read to recent sessions is what would break this pillar: a skill
    // whose only use sits in an older transcript would come back with no records at
    // all, which is the exact opposite of the answer to "is this safe to delete".
    writeTranscript("-tmp-old", "oldest", [attributed("old-skill", "2026-01-05T10:00:00.000Z")]);
    for (let index = 0; index < 40; index++) {
      writeTranscript("-tmp-new", `s${index}`, [
        attributed("new-skill", "2026-06-05T10:00:00.000Z"),
      ]);
    }
    const report = skillActivity(root);
    expect(report.stats.transcriptsScanned).toBe(41);
    expect(report.skills.map((skill) => skill.name).sort()).toEqual([
      "new-skill",
      "old-skill",
    ]);
  });

  it("counts records from dispatched subagents, split from the mainline ones", () => {
    // A skill invoked inside a subagent was invoked, and those records live in a
    // transcript nested below the session directory rather than beside it. Reading
    // only the mainline files leaves the total short and reorders the ranking, which
    // is the one outcome a "safe to delete" list cannot survive. The two counts stay
    // separately named because reaching for a skill and dispatching an agent that
    // reached for it are different facts about a habit.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      attributed("shared-skill", "2026-01-05T10:00:00.000Z"),
      attributed("shared-skill", "2026-01-06T10:00:00.000Z"),
      attributed("mainline-skill", "2026-01-07T10:00:00.000Z"),
      attributed("mainline-skill", "2026-01-08T10:00:00.000Z"),
      attributed("mainline-skill", "2026-01-09T10:00:00.000Z"),
    ]);
    writeSubagentTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", "sub-1", [
      attributed("shared-skill", "2026-01-05T11:00:00.000Z"),
      attributed("shared-skill", "2026-01-05T12:00:00.000Z"),
      attributed("shared-skill", "2026-01-05T13:00:00.000Z"),
      attributed("delegated-only-skill", "2026-01-05T14:00:00.000Z"),
    ]);

    const report = skillActivity(root);
    expect(report.stats.mainlineTranscriptsScanned).toBe(1);
    expect(report.stats.subagentTranscriptsScanned).toBe(1);
    expect(report.stats.transcriptsScanned).toBe(2);
    expect(report.stats.attributedRecords).toBe(9);
    expect(report.stats.mainlineAttributedRecords).toBe(5);
    expect(report.stats.delegatedAttributedRecords).toBe(4);

    // The ranking flips: mainline-only counting makes the 3-record skill heaviest.
    expect(report.skills[0]!.name).toBe("shared-skill");
    const shared = report.skills[0]!;
    expect(shared.attributedRecords).toBe(5);
    expect(shared.mainlineAttributedRecords).toBe(2);
    expect(shared.delegatedAttributedRecords).toBe(3);
    // Delegated work is credited to the conversation that dispatched it, so one
    // session with one subagent is one session and not two.
    expect(shared.sessionsAttributed).toBe(1);

    const delegatedOnly = report.skills.find(
      (skill) => skill.name === "delegated-only-skill",
    )!;
    expect(delegatedOnly.mainlineAttributedRecords).toBe(0);
    expect(delegatedOnly.delegatedAttributedRecords).toBe(1);
  });

  it("reports the corpus span of every record, not just the attributed ones", () => {
    // The two spans answer different questions and one attributed record makes the
    // attribution span 0 while the corpus still covers months. A reader told only the
    // attribution span cannot tell "nothing was found" from "nothing was searched".
    const dayZero = Date.parse("2026-01-01T00:00:00.000Z");
    const history = Array.from({ length: 200 }, (_, index) =>
      unattributed(new Date(dayZero + index * DAY).toISOString()),
    );
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      ...history,
      attributed("lonely-skill", new Date(dayZero + 150 * DAY).toISOString()),
    ]);

    const report = skillActivity(root);
    expect(report.window.spanDays).toBe(0);
    expect(report.corpus.spanDays).toBe(199);
    expect(report.corpus.records).toBe(201);
    expect(report.corpus.recordsWithoutTimestamp).toBe(0);
    expect(report.corpus.firstRecordAt).toBe(new Date(dayZero).toISOString());
  });

  it("counts records with no timestamp as outside the corpus span", () => {
    // The span cannot speak for a record that carries no date, so those are counted
    // rather than folded into the range as if they sat at one of its ends.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      unattributed("2026-01-05T10:00:00.000Z"),
      { type: "assistant", message: { role: "assistant", content: [] } },
      { type: "assistant", timestamp: "not-a-date" },
    ]);
    const corpus = skillActivity(root).corpus;
    expect(corpus.records).toBe(3);
    expect(corpus.recordsWithoutTimestamp).toBe(2);
    expect(corpus.spanDays).toBe(0);
  });

  it("counts an unparseable line instead of failing the read", () => {
    // A live session appends to these files, so catching a half-written final line
    // is expected traffic rather than an error.
    const filePath = writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      attributed("real-skill", "2026-01-05T10:00:00.000Z"),
    ]);
    fs.appendFileSync(filePath, '{"type": "assist', "utf8");
    const report = skillActivity(root);
    expect(report.stats.skippedLines).toBe(1);
    expect(report.stats.attributedRecords).toBe(1);
  });

  it("reports the same skip count on a repeat call as on the first", () => {
    // Per-file results are memoized, and a warm call is the one a long-running server
    // actually serves. A cache that replayed the per-skill counts while dropping the
    // skip count would retire the tripwire that says "a schema change broke parsing"
    // after the first request of the process, which is worse than not having it.
    const filePath = writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      attributed("real-skill", "2026-01-05T10:00:00.000Z"),
      attributed("real-skill", "2026-01-06T10:00:00.000Z"),
    ]);
    fs.appendFileSync(filePath, "{broken\nnot json\n[1,2]\n", "utf8");

    const first = skillActivity(root);
    const second = skillActivity(root);
    const third = skillActivity(root);
    expect(first.stats.skippedLines).toBe(3);
    expect(second.stats.skippedLines).toBe(3);
    expect(third.stats.skippedLines).toBe(3);
    // Everything else has to be stable too, or the report describes the cache.
    expect(second.stats.attributedRecords).toBe(first.stats.attributedRecords);
    expect(second.stats.transcriptsScanned).toBe(first.stats.transcriptsScanned);
    expect(second.corpus).toEqual(first.corpus);
  });

  it("names the missing source rather than returning an empty skill list", () => {
    // An empty list reads as "you have used no skills", which is a different claim.
    expect(() => skillActivity(path.join(root, "absent"))).toThrow(SourceMissingError);
    try {
      skillActivity(path.join(root, "absent"));
    } catch (err) {
      expect((err as SourceMissingError).sourcePath).toBe(path.join(root, "absent"));
    }
  });

  it("treats a path that is a file as a missing source too", () => {
    const filePath = path.join(root, "not-a-dir");
    fs.writeFileSync(filePath, "x", "utf8");
    expect(() => skillActivity(filePath)).toThrow(SourceMissingError);
  });
});

describe("deletionShortlist", () => {
  const NOW = Date.parse("2026-07-01T00:00:00.000Z");

  function counter(name: string, usageCount: number, lastUsedIso: string | null): CounterEntry {
    return {
      name,
      usageCount,
      lastUsedAt: lastUsedIso === null ? 0 : Date.parse(lastUsedIso),
    };
  }

  /** A three-month-wide window, which is the minimum for a burst to mean anything. */
  function wideWindowActivity(): SkillActivityReport {
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      attributed("burst-skill", "2026-01-10T10:00:00.000Z"),
      attributed("burst-skill", "2026-01-11T10:00:00.000Z"),
      attributed("burst-skill", "2026-01-12T10:00:00.000Z"),
      attributed("steady-skill", "2026-01-20T10:00:00.000Z"),
    ]);
    writeTranscript("-tmp-alpha", "bbbbbbbb-2222-4333-8444-555555555555", [
      attributed("steady-skill", "2026-03-20T10:00:00.000Z"),
      attributed("steady-skill", "2026-06-25T10:00:00.000Z"),
      attributed("orphan-skill", "2026-06-26T10:00:00.000Z"),
    ]);
    return skillActivity(root);
  }

  it("calls a skill with no counter and no attribution no-evidence", () => {
    const activity = wideWindowActivity();
    const shortlist = deletionShortlist(activity, [counter("unused-skill", 0, null)], NOW);
    const item = shortlist.items[0]!;
    expect(item.verdict).toBe("no-evidence");
    expect(item.evidence).toBe("none");
    expect(item.attributionEvidence).toBe("absent");
    expect(item.reason).toMatch(/0 invocations/);
    // The wording must not overclaim: a lifetime zero is the strongest signal
    // available and still not proof.
    expect(item.reason).not.toMatch(/proven unused|never used/);
    expect(item.reason).toMatch(/rather than proving/);
  });

  it("calls a skill whose every trace is older than the threshold stale", () => {
    const activity = wideWindowActivity();
    const longAgo = new Date(NOW - (STALE_DAYS + 60) * DAY).toISOString();
    const shortlist = deletionShortlist(activity, [counter("retired-skill", 17, longAgo)], NOW);
    const item = shortlist.items[0]!;
    expect(item.verdict).toBe("stale");
    expect(item.invocations).toBe(17);
    expect(item.daysSinceNewestEvidence).toBe(STALE_DAYS + 60);
  });

  it("says missing evidence, not zero use, when only the counter knows about a skill", () => {
    // Attribution is newer than some of the history and old transcripts get pruned,
    // so an absent attributed record cannot be reported as a zero. This is the
    // wording that stops a skill being deleted on the strength of a short window.
    const activity = wideWindowActivity();
    const longAgo = new Date(NOW - (STALE_DAYS + 10) * DAY).toISOString();
    const shortlist = deletionShortlist(activity, [counter("counter-only", 9, longAgo)], NOW);
    const item = shortlist.items[0]!;
    expect(item.verdict).toBe("stale");
    expect(item.evidence).toBe("counter-only");
    expect(item.attributionEvidence).toBe("absent");
    expect(item.attributedRecords).toBe(0);
    expect(item.reason).toMatch(/missing evidence rather than zero use/);
    expect(item.reason).toMatch(/transcripts on disk/);
  });

  it("calls a skill whose use sits in one old month bursty", () => {
    const activity = wideWindowActivity();
    expect(activity.window.spanDays).toBeGreaterThanOrEqual(BURST_MIN_WINDOW_DAYS);
    const shortlist = deletionShortlist(
      activity,
      [counter("burst-skill", 4, "2026-01-20T10:00:00.000Z")],
      NOW,
    );
    const item = shortlist.items[0]!;
    expect(item.verdict).toBe("bursty");
    expect(item.distinctMonths).toBe(1);
    expect(item.attributedRecords).toBe(3);
    expect(item.reason).toMatch(/2026-01/);
    expect(shortlist.burstClassificationAvailable).toBe(true);
    // The burst month must be measured from its end, and be past the threshold.
    expect(item.daysSinceNewestEvidence).toBeGreaterThan(BURST_STALE_DAYS);
  });

  it("suppresses every bursty verdict when the window is too narrow to support one", () => {
    // The regression this pins came from real data: the transcripts on the machine
    // this was built against reach back about one month while the counter reaches
    // back five, so a plain "all use in one month" test called twenty-two of
    // twenty-nine skills one-month wonders. That is the width of the window, not a
    // fact about anybody's habits.
    //
    // The counter entry is the same one the test above gets a bursty verdict for, so
    // the only thing that changed is how much history the transcripts cover. Here it
    // falls back to the plain age statement, which the data does support.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      attributed("burst-skill", "2026-01-10T10:00:00.000Z"),
      attributed("burst-skill", "2026-01-11T10:00:00.000Z"),
    ]);
    const narrow = skillActivity(root);
    expect(narrow.window.months).toEqual(["2026-01"]);

    const shortlist = deletionShortlist(
      narrow,
      [counter("burst-skill", 4, "2026-01-20T10:00:00.000Z")],
      NOW,
    );
    expect(shortlist.burstClassificationAvailable).toBe(false);
    expect(shortlist.counts.bursty).toBe(0);
    expect(shortlist.items[0]!.verdict).toBe("stale");
    expect(shortlist.items[0]!.attributionEvidence).toBe("found");
    expect(shortlist.items[0]!.reason).toMatch(
      new RegExp(`2 attributed records across 1 month.*past the ${STALE_DAYS}-day threshold`),
    );
    expect(shortlist.note).toMatch(/Bursty verdicts are suppressed/);
  });

  it("claims a burst month only for the records that carry a date", () => {
    // A record with no timestamp is in no month at all, so "all N records fall inside
    // January" is false whenever some of the N are undated. The sentence is what a
    // deletion gets read from, so it counts the dated records and names the rest.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      attributed("undated-burst", "2026-01-10T10:00:00.000Z"),
      { type: "assistant", attributionSkill: "undated-burst" },
      { type: "assistant", attributionSkill: "undated-burst" },
      { type: "assistant", attributionSkill: "undated-burst", timestamp: "not-a-date" },
      attributed("spacer", "2026-01-10T10:00:00.000Z"),
      attributed("spacer", "2026-06-25T10:00:00.000Z"),
    ]);
    const activity = skillActivity(root);
    const shortlist = deletionShortlist(
      activity,
      [counter("undated-burst", 4, "2026-01-20T10:00:00.000Z")],
      NOW,
    );
    const item = shortlist.items[0]!;
    expect(item.verdict).toBe("bursty");
    expect(item.attributedRecords).toBe(4);
    expect(item.recordsWithoutTimestamp).toBe(3);
    expect(item.reason).toMatch(/All 1 dated attributed record falls inside 2026-01/);
    expect(item.reason).toMatch(/A further 3 attributed records carry no timestamp/);
    // The overclaiming version of this sentence, which the histogram cannot support.
    expect(item.reason).not.toMatch(/All 4 attributed records fall inside/);
  });

  it("names undated records in the stale sentence rather than filing them under months", () => {
    // Milder version of the same overclaim: "N attributed records across M months"
    // reads as all N sitting inside those M months.
    // Two dated months keeps this off the burst path, so the stale sentence is the
    // one under test.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      attributed("mixed-stale", "2026-01-10T10:00:00.000Z"),
      attributed("mixed-stale", "2026-02-10T10:00:00.000Z"),
      { type: "assistant", attributionSkill: "mixed-stale" },
      attributed("spacer", "2026-01-10T10:00:00.000Z"),
      attributed("spacer", "2026-06-25T10:00:00.000Z"),
    ]);
    const activity = skillActivity(root);
    const longAgo = new Date(NOW - (STALE_DAYS + 200) * DAY).toISOString();
    const shortlist = deletionShortlist(
      activity,
      [counter("mixed-stale", 3, longAgo)],
      NOW,
    );
    const item = shortlist.items[0]!;
    expect(item.verdict).toBe("stale");
    expect(item.attributedRecords).toBe(3);
    expect(item.recordsWithoutTimestamp).toBe(1);
    expect(item.reason).toMatch(
      /2 dated attributed records across 2 months, plus 1 record with no timestamp/,
    );
    expect(item.reason).not.toMatch(/3 attributed records across 2 months/);
  });

  it("measures the burst guard in elapsed days, not in calendar months touched", () => {
    // Two trees of identical width, 33 days each, differing only in where the month
    // boundaries fall: the first touches three calendar months and the second two. A
    // guard that counts months called the same evidence sufficient in one and
    // insufficient in the other, which decided a deletion verdict on placement alone.
    function thirtyThreeDayTree(base: string, firstDay: string, lastDay: string) {
      fs.mkdirSync(base, { recursive: true });
      writeTranscriptIn(base, "-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
        attributed("edge-spacer", firstDay),
        attributed("edge-spacer", lastDay),
        attributed("edge-skill", "2026-02-10T10:00:00.000Z"),
        attributed("edge-skill", "2026-02-11T10:00:00.000Z"),
        attributed("edge-skill", "2026-02-12T10:00:00.000Z"),
      ]);
      return deletionShortlist(
        skillActivity(base),
        [counter("edge-skill", 3, "2026-02-15T10:00:00.000Z")],
        NOW,
      );
    }

    const straddlingThreeMonths = thirtyThreeDayTree(
      path.join(root, "placement-a"),
      "2026-01-31T23:00:00.000Z",
      "2026-03-05T23:00:00.000Z",
    );
    const straddlingTwoMonths = thirtyThreeDayTree(
      path.join(root, "placement-b"),
      "2026-02-05T23:00:00.000Z",
      "2026-03-10T23:00:00.000Z",
    );

    expect(straddlingThreeMonths.window.spanDays).toBe(33);
    expect(straddlingTwoMonths.window.spanDays).toBe(33);
    // The month count still differs; the guard no longer listens to it.
    expect(straddlingThreeMonths.window.months).toHaveLength(3);
    expect(straddlingTwoMonths.window.months).toHaveLength(2);

    expect(straddlingThreeMonths.burstClassificationAvailable).toBe(false);
    expect(straddlingTwoMonths.burstClassificationAvailable).toBe(false);
    expect(straddlingThreeMonths.items[0]!.verdict).toBe("stale");
    expect(straddlingTwoMonths.items[0]!.verdict).toBe("stale");
    expect(straddlingThreeMonths.note).toMatch(
      new RegExp(`span 33 days, short of the ${BURST_MIN_WINDOW_DAYS} days`),
    );
  });

  it("quotes the searched corpus, not the attribution span, when nothing was found", () => {
    // The state the module was built for: attribution is newer than the history, so a
    // long corpus can hold a single attributed record. Reporting the attribution span
    // as "the days of transcripts on disk" turns 200 days of searched history into
    // "0 days", which reads as no evidence having been available at all.
    const dayZero = Date.parse("2026-01-01T00:00:00.000Z");
    const history = Array.from({ length: 200 }, (_, index) =>
      unattributed(new Date(dayZero + index * DAY).toISOString()),
    );
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      ...history,
      attributed("lonely-skill", new Date(dayZero + 150 * DAY).toISOString()),
    ]);
    const activity = skillActivity(root);
    expect(activity.window.spanDays).toBe(0);

    const shortlist = deletionShortlist(
      activity,
      [counter("ghost-skill", 0, null), counter("old-hand", 4, "2026-01-05T10:00:00.000Z")],
      NOW,
    );
    expect(shortlist.corpus.spanDays).toBe(199);
    const noEvidence = shortlist.items.find((item) => item.name === "ghost-skill")!;
    expect(noEvidence.verdict).toBe("no-evidence");
    expect(noEvidence.reason).toMatch(/199 days of transcripts on disk/);
    expect(noEvidence.reason).not.toMatch(/0 days of transcripts on disk/);
    const stale = shortlist.items.find((item) => item.name === "old-hand")!;
    expect(stale.verdict).toBe("stale");
    expect(stale.reason).toMatch(/199 days of transcripts on disk/);
    expect(stale.reason).not.toMatch(/0 days of transcripts on disk/);
  });

  it("says so when no transcript records attribution at all", () => {
    // A corpus with no attribution anywhere is a recording gap, not a finding about
    // any one skill, and the sentence has to say that where the absence is claimed or
    // a no-evidence verdict reads as proof the skill went unused.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      unattributed("2026-01-05T10:00:00.000Z"),
      unattributed("2026-06-05T10:00:00.000Z"),
    ]);
    const activity = skillActivity(root);
    expect(activity.stats.attributedRecords).toBe(0);

    const shortlist = deletionShortlist(activity, [counter("ghost-skill", 0, null)], NOW);
    const item = shortlist.items[0]!;
    expect(item.verdict).toBe("no-evidence");
    expect(item.reason).toMatch(
      /151 days of transcripts on disk, none of which record skill attribution at all/,
    );
    expect(item.reason).not.toMatch(/proven unused|never used/);
  });

  it("does not call a skill with attributed records no-evidence just because the counter is zero", () => {
    // The counter can miss a skill entirely; two attribution names on the machine
    // this was built against appear in no counter entry at all. Records in the
    // transcripts are evidence of use whatever the counter says.
    const activity = wideWindowActivity();
    const shortlist = deletionShortlist(activity, [counter("steady-skill", 0, null)], NOW);
    const item = shortlist.items[0]!;
    expect(item.verdict).not.toBe("no-evidence");
    expect(item.evidence).toBe("attribution-only");
    expect(item.invocations).toBe(0);
    expect(item.attributedRecords).toBe(3);
  });

  it("does not call a recently invoked skill bursty on the strength of old attribution", () => {
    // Attribution lags: the transcripts that would show last week's use may already
    // have been pruned, or predate the field. A burst verdict therefore requires that
    // nothing has been recorded from either source since the burst, or a skill invoked
    // days ago would be shortlisted for deletion.
    const activity = wideWindowActivity();
    const shortlist = deletionShortlist(
      activity,
      [counter("burst-skill", 4, "2026-06-29T10:00:00.000Z")],
      NOW,
    );
    const item = shortlist.items[0]!;
    expect(item.distinctMonths).toBe(1);
    expect(item.daysSinceNewestEvidence).toBe(1);
    expect(item.verdict).toBe("keep");
  });

  it("keeps a skill still in use", () => {
    const activity = wideWindowActivity();
    const shortlist = deletionShortlist(
      activity,
      [counter("steady-skill", 30, "2026-06-28T10:00:00.000Z")],
      NOW,
    );
    const item = shortlist.items[0]!;
    expect(item.verdict).toBe("keep");
    expect(item.evidence).toBe("counter-and-attribution");
    expect(item.distinctMonths).toBe(3);
    expect(item.daysSinceNewestEvidence).toBe(2);
  });

  it("keeps a skill whose age cannot be established rather than guessing", () => {
    // A recorded count with no usable date is evidence of use with no evidence of
    // when. Guessing would push it onto a deletion list on no information at all.
    const activity = wideWindowActivity();
    const shortlist = deletionShortlist(activity, [counter("dateless", 6, null)], NOW);
    const item = shortlist.items[0]!;
    expect(item.verdict).toBe("keep");
    expect(item.daysSinceNewestEvidence).toBeNull();
    expect(item.reason).toMatch(/age cannot be established/);
  });

  it("takes the newer of the two dates as the newest evidence", () => {
    // Timestamps are the one thing the two sources genuinely share a unit for, so
    // comparing them is legitimate where combining their counts is not. A stale
    // counter date must not outvote a recent attributed record.
    const activity = wideWindowActivity();
    const shortlist = deletionShortlist(
      activity,
      [counter("steady-skill", 3, "2025-01-01T00:00:00.000Z")],
      NOW,
    );
    const item = shortlist.items[0]!;
    expect(item.lastInvokedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(item.lastAttributedAt).toBe("2026-06-25T10:00:00.000Z");
    expect(item.daysSinceNewestEvidence).toBe(5);
    expect(item.verdict).toBe("keep");
  });

  it("never combines invocations with attributed records", () => {
    // The two are different units and rank skills in different orders: the counter's
    // heaviest skill is not the transcripts' heaviest. A sum, a difference or a mean
    // of the two would be a number that means nothing while looking authoritative,
    // so no field anywhere in the output may hold one.
    const records = Array.from({ length: 100 }, (_, index) =>
      attributed("loud-skill", `2026-06-0${(index % 9) + 1}T10:00:00.000Z`),
    );
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      ...records,
      attributed("spacer", "2026-01-01T10:00:00.000Z"),
      attributed("spacer", "2026-03-01T10:00:00.000Z"),
    ]);
    const activity = skillActivity(root);
    const shortlist = deletionShortlist(
      activity,
      [counter("loud-skill", 5, "2026-06-28T10:00:00.000Z")],
      NOW,
    );
    const item = shortlist.items[0]!;
    expect(item.invocations).toBe(5);
    expect(item.attributedRecords).toBe(100);

    // Every number the item carries except the age, which is a span of days and so
    // cannot be confused with either count.
    const { daysSinceNewestEvidence: _age, ...countBearing } = item;
    const numbers: number[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "number") numbers.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") Object.values(value).forEach(walk);
    };
    walk(countBearing);
    const forbidden = new Set([105, 95, -95, 52.5, 500, 20]);
    for (const value of numbers) expect(forbidden.has(value)).toBe(false);
    // The histogram belongs to the record unit alone; it must total the records and
    // never pick up the invocations.
    const histogramTotal = item.months.reduce((sum, month) => sum + month.attributedRecords, 0);
    expect(histogramTotal).toBe(item.attributedRecords);

    // Both units are named in the fields that carry them, so a reader can never be
    // shown one and told it is the other.
    expect(Object.keys(item)).toContain("invocations");
    expect(Object.keys(item)).toContain("attributedRecords");
  });

  it("lists attribution it could not join instead of inventing a candidate for it", () => {
    // Built-in skills and bundled commands are attributed in transcripts and never
    // appear in a skills inventory. Shortlisting one would recommend deleting
    // something that may not be installed in the first place.
    const activity = wideWindowActivity();
    const shortlist = deletionShortlist(
      activity,
      [counter("steady-skill", 3, "2026-06-28T10:00:00.000Z")],
      NOW,
    );
    expect(shortlist.attributionWithoutCounter).toEqual(["burst-skill", "orphan-skill"]);
    expect(shortlist.items.map((item) => item.name)).toEqual(["steady-skill"]);
  });

  it("matches a bare counter name to a namespaced attribution name", () => {
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      attributed("some-plugin:brainstorming", "2026-06-25T10:00:00.000Z"),
      attributed("filler", "2026-01-01T10:00:00.000Z"),
      attributed("filler", "2026-03-01T10:00:00.000Z"),
    ]);
    const activity = skillActivity(root);
    const shortlist = deletionShortlist(
      activity,
      [counter("brainstorming", 4, "2026-06-26T10:00:00.000Z")],
      NOW,
    );
    expect(shortlist.items[0]!.attributedRecords).toBe(1);
    expect(shortlist.items[0]!.evidence).toBe("counter-and-attribution");
  });

  it("tolerates a leading slash on a counter name", () => {
    const activity = wideWindowActivity();
    const shortlist = deletionShortlist(
      activity,
      [counter("/steady-skill", 3, "2026-06-28T10:00:00.000Z")],
      NOW,
    );
    expect(shortlist.items[0]!.attributedRecords).toBe(3);
  });

  it("refuses the bare-name match when two plugins share a skill name", () => {
    // Crediting one skill's records to both would silently double them, and a wrong
    // number is presented with exactly the same confidence as a right one.
    writeTranscript("-tmp-alpha", "aaaaaaaa-1111-4222-8333-444444444444", [
      attributed("plugin-a:review", "2026-06-25T10:00:00.000Z"),
      attributed("plugin-b:review", "2026-06-25T11:00:00.000Z"),
      attributed("filler", "2026-01-01T10:00:00.000Z"),
      attributed("filler", "2026-03-01T10:00:00.000Z"),
    ]);
    const activity = skillActivity(root);
    const shortlist = deletionShortlist(
      activity,
      [counter("review", 4, "2026-06-26T10:00:00.000Z")],
      NOW,
    );
    expect(shortlist.items[0]!.attributedRecords).toBe(0);
    expect(shortlist.items[0]!.attributionEvidence).toBe("absent");
  });

  it("ranks the most deletable first and the oldest first within a verdict", () => {
    const activity = wideWindowActivity();
    const shortlist = deletionShortlist(
      activity,
      [
        counter("steady-skill", 30, "2026-06-28T10:00:00.000Z"),
        counter("burst-skill", 4, "2026-01-20T10:00:00.000Z"),
        counter("stale-recent", 5, new Date(NOW - (STALE_DAYS + 5) * DAY).toISOString()),
        counter("stale-ancient", 5, new Date(NOW - (STALE_DAYS + 460) * DAY).toISOString()),
        counter("never-touched", 0, null),
      ],
      NOW,
    );
    // no-evidence leads, then the quiet skills oldest first regardless of which of
    // the two quiet verdicts they carry, then what is still in use.
    expect(shortlist.items.map((item) => item.name)).toEqual([
      "never-touched",
      "stale-ancient",
      "burst-skill",
      "stale-recent",
      "steady-skill",
    ]);
    expect(shortlist.counts).toEqual({
      "no-evidence": 1,
      stale: 2,
      bursty: 1,
      keep: 1,
    });
  });

  it("reports its thresholds so a reader is not left guessing at the rule", () => {
    const activity = wideWindowActivity();
    const shortlist = deletionShortlist(activity, [], NOW);
    expect(shortlist.thresholds).toEqual({
      staleDays: STALE_DAYS,
      burstStaleDays: BURST_STALE_DAYS,
      burstMinWindowDays: BURST_MIN_WINDOW_DAYS,
    });
    expect(shortlist.items).toEqual([]);
    expect(shortlist.note).toMatch(/never/i);
  });

  it("writes nothing and removes nothing while producing a shortlist", () => {
    // The shortlist is a recommendation to read. It has to be structurally
    // impossible for it to act, so the tree it was derived from is compared before
    // and after.
    const activity = wideWindowActivity();
    const before = fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort();
    deletionShortlist(activity, [counter("burst-skill", 4, "2026-01-20T10:00:00.000Z")], NOW);
    const after = fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .map((entry) => path.join(entry.parentPath, entry.name))
      .sort();
    expect(after).toEqual(before);
  });
});
