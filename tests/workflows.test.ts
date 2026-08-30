import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readWorkflowScript, workflowInventory } from "../server/workflows.js";

/**
 * `readWorkflowScript` backs `/api/workflows/source`, which reads a file at a
 * path the CLIENT supplies. Its containment is an exact-match allowlist against
 * the inventory rather than a prefix check, and until now nothing pinned that:
 * loosening it to a `startsWith` or a `resolve`-and-compare would have kept
 * every test green while opening a traversal. These are the tests that go red.
 *
 * Fixtures are hand-written; nothing is read from the operator's real dirs.
 */
let root = "";
let transcriptsDir = "";
let workflowsDir = "";
let outsideFile = "";

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-os-workflows-"));
  transcriptsDir = path.join(root, "transcripts");
  workflowsDir = path.join(root, "workflows");

  write(
    path.join(workflowsDir, "known.js"),
    "export const meta = { name: 'known', description: 'a saved workflow' }\nawait agent('do a thing')\n",
  );
  // A secret next to the allowed tree, which is what a traversal would be after.
  outsideFile = path.join(root, "secret.txt");
  write(outsideFile, "SHOULD-NEVER-BE-SERVED\n");
  fs.mkdirSync(transcriptsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("readWorkflowScript containment", () => {
  it("serves a script the inventory actually produced", () => {
    const inventory = workflowInventory(transcriptsDir, workflowsDir);
    const known = inventory.scripts.find((s) => s.name === "known");
    expect(known, "fixture did not land in the inventory").toBeTruthy();

    const result = readWorkflowScript(transcriptsDir, workflowsDir, known!.path);
    expect(result).not.toBeNull();
    expect(result!.source).toContain("a saved workflow");
  });

  it("refuses a traversal path that escapes the workflows dir", () => {
    const traversal = path.join(workflowsDir, "..", "secret.txt");
    expect(readWorkflowScript(transcriptsDir, workflowsDir, traversal)).toBeNull();
  });

  it("refuses the resolved form of that same traversal", () => {
    // A `resolve`-then-`startsWith(root)` guard would let this through, since
    // the secret does sit under the fixture root. Only membership of the
    // inventory keeps it out.
    expect(readWorkflowScript(transcriptsDir, workflowsDir, outsideFile)).toBeNull();
  });

  it("refuses a real file inside the workflows dir that the inventory skipped", () => {
    // This is the case a prefix check cannot distinguish: the path is genuinely
    // under workflowsDir and genuinely exists, and it is still not servable.
    const notAScript = path.join(workflowsDir, "notes.txt");
    write(notAScript, "not a workflow\n");
    expect(readWorkflowScript(transcriptsDir, workflowsDir, notAScript)).toBeNull();
  });

  it("does follow a symlink placed inside the dir, which is the known limit", () => {
    // Pinned deliberately, and NOT as an endorsement. A `*.js` symlink in the
    // workflows directory is enumerated like any other script, so its target is
    // served from outside the tree. That is reachable only by someone who can
    // already write to the directory, never by an API client, which is why it
    // is documented rather than blocked. If anyone ever hardens this, THIS test
    // is the one that should fail and force the decision to be explicit.
    const link = path.join(workflowsDir, "link.js");
    fs.symlinkSync(outsideFile, link);
    const result = readWorkflowScript(transcriptsDir, workflowsDir, link);
    expect(result).not.toBeNull();
    expect(result!.source).toContain("SHOULD-NEVER-BE-SERVED");
  });

  it("refuses a path that only shares a prefix with an allowed script", () => {
    const inventory = workflowInventory(transcriptsDir, workflowsDir);
    const known = inventory.scripts.find((s) => s.name === "known");
    const sneaky = `${known!.path}.bak`;
    write(sneaky, "SHOULD-NEVER-BE-SERVED\n");
    expect(readWorkflowScript(transcriptsDir, workflowsDir, sneaky)).toBeNull();
  });
});
