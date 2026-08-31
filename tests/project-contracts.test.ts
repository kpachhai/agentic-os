import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The declared contracts in .claudecode.md must still name things that exist.
 *
 * A declaration does not go wrong by its wording drifting; it goes wrong when a
 * file is renamed, a script dropped or a target folded away and the document
 * keeps describing a repo that moved on. A stale contract is worse than none,
 * because it is read as current.
 */
const ROOT = path.resolve(__dirname, "..");

describe("project contracts", () => {
  // 120s, not the 30s default: this shells out to git while the rest of the
  // suite runs in parallel, and measured 1s alone against 44s under load.
  it("names only referents that still exist", { timeout: 120_000 }, () => {
    let out = "";
    let failed = false;
    try {
      out = execFileSync("bash", [path.join(ROOT, "scripts/project-contracts-check.sh"), ROOT], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string };
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    expect(failed, `.claudecode.md names something that is gone:\n${out}`).toBe(false);
  });
});
