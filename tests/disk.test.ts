import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SourceMissingError } from "../server/config.js";
import { diskReport } from "../server/disk.js";

/** A synthetic Claude home; the real one is 1.4 GB of the operator's history. */

let root = "";
let settingsPath = "";

function write(relative: string, bytes: number): void {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, "x".repeat(bytes), "utf8");
}

function report() {
  return diskReport(root, settingsPath);
}

function category(key: string) {
  const found = report().categories.find((c) => c.key === key);
  if (!found) throw new Error(`no category ${key}`);
  return found;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-disk-"));
  settingsPath = path.join(root, "settings.json");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("diskReport", () => {
  it("names the path when the home directory is absent", () => {
    expect(() => diskReport(path.join(root, "nope"), settingsPath)).toThrow(
      SourceMissingError,
    );
  });

  it("sums a category recursively", () => {
    write("projects/-a-b/one.jsonl", 100);
    write("projects/-a-b/two.jsonl", 200);
    write("projects/-c-d/three.jsonl", 300);

    const transcripts = category("transcripts");
    expect(transcripts.bytes).toBe(600);
    expect(transcripts.files).toBe(3);
    expect(transcripts.present).toBe(true);
  });

  it("reports an absent category as absent rather than as empty", () => {
    write("projects/-a-b/one.jsonl", 10);
    const downloads = category("downloads");
    expect(downloads.present).toBe(false);
    expect(downloads.bytes).toBe(0);
  });

  it("counts a notable file on its own", () => {
    write("history.jsonl", 4096);
    expect(category("history").bytes).toBe(4096);
    expect(category("history").files).toBe(1);
  });

  it("counts what no category claimed rather than dropping it", () => {
    write("projects/-a-b/one.jsonl", 100);
    write("something-unmapped/blob.bin", 500);

    const result = report();
    expect(result.otherBytes).toBe(500);
    // The total has to cover the install, or the categories quietly fail to add up.
    expect(result.totalBytes).toBe(600);
  });

  it("does not follow a symlink out of the tree", () => {
    // A skill linked in from another checkout would otherwise be billed here,
    // and a link pointing upward would make the walk unbounded.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-outside-"));
    fs.writeFileSync(path.join(outside, "big.bin"), "x".repeat(9999), "utf8");
    fs.mkdirSync(path.join(root, "skills"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "skills", "linked"));

    expect(category("skills").bytes).toBe(0);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("sorts the largest category first", () => {
    write("projects/-a-b/one.jsonl", 5000);
    write("downloads/small.bin", 10);
    expect(report().categories[0]!.key).toBe("transcripts");
  });

  it("reads the retention setting that bounds the transcript tree", () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ cleanupPeriodDays: 45 }), "utf8");
    expect(report().cleanupPeriodDays).toBe(45);
  });

  it("reports an unset retention as null rather than guessing the default", () => {
    // Guessing would put a made-up bound next to a real size.
    expect(report().cleanupPeriodDays).toBeNull();
    fs.writeFileSync(settingsPath, "{ not json", "utf8");
    expect(report().cleanupPeriodDays).toBeNull();
  });

  it("carries the newest write per category", () => {
    write("projects/-a-b/one.jsonl", 10);
    expect(category("transcripts").newestMtime).not.toBeNull();
    expect(category("downloads").newestMtime).toBeNull();
  });
});
