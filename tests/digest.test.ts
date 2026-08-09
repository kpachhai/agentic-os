import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDigest,
  cachedParaphrase,
  contentHash,
  isLoopbackUrl,
  paraphrase,
  probeLocalModel,
  withParaphrase,
  type LocalModelState,
} from "../server/digest.js";

const DIGEST_CONFIG = {
  localModelUrl: "http://127.0.0.1:8080",
  model: null,
  maxGrade: 12,
};

const LONG_BODY = [
  "## Launch bounds",
  "",
  "The launcher clamps every per-launch override to the configured ceiling.",
  "A request cannot widen the tool allowlist, because the requested list is",
  "intersected with the configured default rather than replacing it.",
  "The working directory must resolve inside the configured launch directory.",
  "Timeouts and budgets are clamped to the configured maximum.",
  "Nothing in this file writes to a data source.",
].join("\n");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildDigest", () => {
  it("puts the operator's own summary first, verbatim", () => {
    const digest = buildDigest({
      verbatimSummary: "Every launch override narrows, never widens",
      body: LONG_BODY,
    });
    expect(digest.lines[0]!.provenance).toBe("verbatim");
    expect(digest.lines[0]!.text).toBe("Every launch override narrows, never widens");
    expect(digest.tiers).toContain("structural");
  });

  it("selects existing sentences and can point at each one's source", () => {
    const digest = buildDigest({ body: LONG_BODY });
    const selected = digest.lines.filter((l) => l.provenance === "selected");
    expect(selected.length).toBeGreaterThan(0);
    for (const line of selected) {
      // A selected line must be traceable, which is what makes the provenance
      // claim honest rather than decorative.
      expect(line.sourceIndex).not.toBeNull();
      expect(line.sourceText).toBe(line.text);
    }
    expect(digest.tiers).toContain("extractive");
  });

  it("never emits text that is not in the source", () => {
    const digest = buildDigest({ body: LONG_BODY });
    for (const line of digest.lines) {
      expect(LONG_BODY).toContain(line.text.replace(/\s+/g, " ").trim().slice(0, 40));
    }
  });

  it("treats a short body as its own digest rather than ranking it", () => {
    const digest = buildDigest({ body: "The bind is loopback only." });
    expect(digest.lines).toHaveLength(1);
    expect(digest.lines[0]!.provenance).toBe("verbatim");
    expect(digest.lines.every((l) => l.provenance !== "selected")).toBe(true);
  });

  it("returns an empty digest for empty input instead of throwing", () => {
    const digest = buildDigest({ body: "" });
    expect(digest.lines).toEqual([]);
    expect(Number.isFinite(digest.grade)).toBe(true);
  });

  it("reports a readability grade the gate can assert against", () => {
    const digest = buildDigest({ body: LONG_BODY });
    expect(Number.isFinite(digest.grade)).toBe(true);
    expect(digest.grade).toBeGreaterThan(0);
  });

  it("extracts keywords for faceting", () => {
    const digest = buildDigest({ body: LONG_BODY });
    expect(digest.keywords.length).toBeGreaterThan(0);
    expect(digest.keywords.every((k) => k === k.toLowerCase())).toBe(true);
  });
});

describe("isLoopbackUrl", () => {
  it("accepts only loopback addresses", () => {
    expect(isLoopbackUrl("http://127.0.0.1:8080")).toBe(true);
    expect(isLoopbackUrl("http://localhost:11434")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:1234")).toBe(true);
  });

  it("rejects anything that would send the operator's notes off-machine", () => {
    // This is the check that keeps a "local" paraphrase local. A remote endpoint
    // here would ship the operator's own notes to somebody else's server.
    expect(isLoopbackUrl("http://192.168.1.10:8080")).toBe(false);
    expect(isLoopbackUrl("https://api.example.com/v1")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1.evil.test")).toBe(false);
    expect(isLoopbackUrl("file:///etc/passwd")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});

describe("probeLocalModel", () => {
  it("reports absent when nothing is listening, naming what it probed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const state = await probeLocalModel(DIGEST_CONFIG);
    expect(state.state).toBe("absent");
    if (state.state === "absent") {
      expect(state.probed.length).toBeGreaterThanOrEqual(1);
      expect(state.detail).toContain("Nothing is downloaded or started");
    }
  });

  it("distinguishes a runner that is still loading from one that is absent", async () => {
    // Three states, not two: telling the operator "no model found" while a runner
    // warms up would send them chasing a problem about to resolve itself.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve('{"error":{"message":"Loading model"}}'),
      } as unknown as Response),
    );
    const state = await probeLocalModel(DIGEST_CONFIG);
    expect(state.state).toBe("loading");
  });

  it("does not call an unrelated service on the same port a model runner", async () => {
    // The failure this pins actually happened. Another dev server held the
    // llama.cpp default port, answered /health with a 200, and was reported as
    // ready; the paraphrase then failed with an HTTP 426 at the point of use,
    // which is far too late to find out. Readiness now requires a NAMED MODEL.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (String(url).endsWith("/health")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve("OK"),
          } as unknown as Response);
        }
        // A service that is not a model runner: no model list.
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [] }),
        } as unknown as Response);
      }),
    );
    const state = await probeLocalModel(DIGEST_CONFIG);
    expect(state.state).toBe("absent");
  });

  it("treats a generic 503 from a non-model service as absent, not loading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve("Service Unavailable"),
        json: () => Promise.resolve({}),
      } as unknown as Response),
    );
    const state = await probeLocalModel(DIGEST_CONFIG);
    expect(state.state).toBe("absent");
  });

  it("reports ready and the served model name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (String(url).endsWith("/health")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            text: () => Promise.resolve("OK"),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ data: [{ id: "qwen2.5-3b-instruct" }] }),
        } as unknown as Response);
      }),
    );
    const state = await probeLocalModel(DIGEST_CONFIG);
    expect(state.state).toBe("ready");
    if (state.state === "ready") expect(state.model).toBe("qwen2.5-3b-instruct");
  });
});

describe("paraphrase", () => {
  const ready: LocalModelState = {
    state: "ready",
    url: "http://127.0.0.1:8080",
    model: "test-model",
    detail: "ready",
  };

  it("refuses to run when no model is ready", async () => {
    await expect(
      paraphrase({ state: "absent", probed: [], detail: "none" }, "some record"),
    ).rejects.toThrow(/not ready/);
  });

  it("returns the single sentence the schema asked for", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    sentence: "We stopped the chart from overflowing and added a visual check.",
                  }),
                },
              },
            ],
          }),
      } as unknown as Response),
    );
    const result = await paraphrase(ready, "unique-record-for-sentence-test");
    expect(result.sentence).toBe(
      "We stopped the chart from overflowing and added a visual check.",
    );
    expect(result.model).toBe("test-model");
  });

  it("caches by content hash so a record is never regenerated", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: JSON.stringify({ sentence: "Cached." }) } }],
        }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const text = "a-record-used-only-by-the-cache-test";
    await paraphrase(ready, text);
    await paraphrase(ready, text);
    // Generation costs seconds per record on a CPU-only machine, and the same
    // input yields the same sentence, so a second call must not reach the model.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cachedParaphrase(text)!.sentence).toBe("Cached.");
  });

  it("rejects a reply that is not the requested shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: "this is not json at all" } }],
          }),
      } as unknown as Response),
    );
    await expect(paraphrase(ready, "unique-bad-shape-record")).rejects.toThrow(
      /not the requested shape/,
    );
  });

  it("rejects a schema-valid reply carrying an empty sentence", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: JSON.stringify({ sentence: "   " }) } }],
          }),
      } as unknown as Response),
    );
    await expect(paraphrase(ready, "unique-empty-sentence-record")).rejects.toThrow();
  });
});

describe("withParaphrase", () => {
  it("appends the rewrite beside the operator's own words rather than replacing them", () => {
    const digest = buildDigest({
      verbatimSummary: "Every launch override narrows",
      body: LONG_BODY,
    });
    const before = digest.lines.length;
    const merged = withParaphrase(
      digest,
      { sentence: "Launch settings can only get stricter.", model: "m", hash: "h" },
      "source record text",
    );

    expect(merged.lines).toHaveLength(before + 1);
    // The operator's own lines survive, so the rewrite can be checked against them.
    expect(merged.lines[0]!.provenance).toBe("verbatim");
    const last = merged.lines[merged.lines.length - 1]!;
    expect(last.provenance).toBe("paraphrase");
    expect(last.sourceText).toBe("source record text");
    expect(merged.tiers).toContain("abstractive");
  });
});

describe("contentHash", () => {
  it("is stable and input-sensitive", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });
});
