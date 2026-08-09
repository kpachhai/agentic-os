import * as redactModule from "../server/redact.js";
import { describe, expect, it } from "vitest";
import {
  REDACTED,
  isSecretKey,
  redactCommandArgs,
  redactDeep,
} from "../server/redact.js";

// Every fixture here is invented. Nothing in this file may be copied from a
// real settings file, MCP definition or config backup on the machine.

/** Redact one property and hand back what the reader would see for it. */
function redactedProperty(key: string, value: unknown): unknown {
  const out = redactDeep({ [key]: value } as Record<string, unknown>);
  return out[key];
}

describe("isSecretKey - keys that must be redacted", () => {
  const secretSpellings = [
    "key",
    "apiKey",
    "api_key",
    "API_KEY",
    "x-api-key",
    "apikey",
    "token",
    "accessToken",
    "access_token",
    "ACCESS_TOKEN",
    "secret",
    "Secret",
    "password",
    "passwd",
    "credential",
    "credentials",
    "authorization",
    "Authorization",
    "auth",
    "bearer",
    "privateKey",
    "private_key",
    "PRIVATE_KEY",
    "clientSecret",
    "client-secret",
    "CLIENT_SECRET",
    "sessionKey",
    "cookie",
    "Cookie",
    "signature",
    "apiKey2",
    "OPENAI_API_KEY",
    // Credential spellings that used to be missing from the word list.
    "pass",
    "passphrase",
    "PASSPHRASE",
    "jwt",
    "githubPat",
    "pat",
  ];

  for (const spelling of secretSpellings) {
    it(`redacts ${spelling}`, () => {
      expect(isSecretKey(spelling)).toBe(true);
      expect(redactedProperty(spelling, "s3cret-material")).toBe(REDACTED);
    });
  }
});

describe("isSecretKey - keys that must NOT be redacted", () => {
  const benignKeys = [
    "keyboard",
    "keyboardShortcuts",
    "tokenizer",
    "monkey",
    "secretary",
    "keyRoots",
    "tokenCount",
    "authorize",
    "description",
    "name",
    "command",
    "model",
  ];

  for (const benignKey of benignKeys) {
    it(`leaves ${benignKey} alone`, () => {
      expect(isSecretKey(benignKey)).toBe(false);
      expect(redactedProperty(benignKey, "visible")).toBe("visible");
    });
  }

  it("leaves a description that contains the word authorize intact", () => {
    const text = "Ask the operator to authorize the connection before use.";
    expect(redactedProperty("description", text)).toBe(text);
  });
});

describe("only strings can be credentials", () => {
  it("keeps token counts readable", () => {
    // These are the column aliases the token-spend query selects, so redacting
    // them would erase the pillar that reads it.
    const input = {
      inputTokens: 1234,
      outputTokens: 99,
      cacheReadTokens: 7,
      totalTokens: 1340,
    };
    expect(redactDeep(input)).toEqual(input);
  });

  it("keeps boolean is-it-configured flags readable", () => {
    // A boolean carries no credential material, and hiding it destroys the one
    // thing the reader wanted: whether a token is set at all.
    const input = { hasToken: false, hasKey: true, usesAuth: false };
    expect(redactDeep(input)).toEqual(input);
  });

  it("passes non-string values under a secret key straight through", () => {
    expect(redactedProperty("apiKey", 12345)).toBe(12345);
    expect(redactedProperty("token", null)).toBeNull();
    expect(redactedProperty("secret", true)).toBe(true);
    expect(redactedProperty("password", undefined)).toBeUndefined();
  });

  it("still redacts the strings nested under a secret key", () => {
    const out = redactDeep({ token: { nested: "invented", count: 3 } });
    expect(out.token).toEqual({ nested: REDACTED, count: 3 });
  });
});

describe("redactDeep", () => {
  it("redacts by key at depth 3 and beyond", () => {
    const input = {
      level1: {
        level2: {
          level3: {
            apiKey: "deep-secret",
            label: "deep-visible",
            level4: { session_key: "deeper-secret", count: 4 },
          },
        },
      },
    };
    const out = redactDeep(input);
    expect(out.level1.level2.level3.apiKey).toBe(REDACTED);
    expect(out.level1.level2.level3.label).toBe("deep-visible");
    expect(out.level1.level2.level3.level4.session_key).toBe(REDACTED);
    expect(out.level1.level2.level3.level4.count).toBe(4);
  });

  it("redacts every string in an env block even when the names look innocuous", () => {
    const input = {
      mcpServers: {
        example: {
          command: "npx",
          env: {
            REGION: "us-east-1",
            PROJECT_NAME: "widgets",
            OPAQUE_BLOB: "live-credential-material",
          },
        },
      },
    };
    const out = redactDeep(input);
    const env = out.mcpServers.example.env;
    expect(Object.keys(env)).toEqual(["REGION", "PROJECT_NAME", "OPAQUE_BLOB"]);
    expect(Object.values(env)).toEqual([REDACTED, REDACTED, REDACTED]);
    expect(out.mcpServers.example.command).toBe("npx");
  });

  it("redacts a headers block including its Authorization header", () => {
    const input = {
      headers: {
        Authorization: "Bearer invented-token-value",
        "Content-Type": "application/json",
        nested: { "X-Trace": "trace-1" },
      },
    };
    const out = redactDeep(input);
    expect(out.headers.Authorization).toBe(REDACTED);
    expect(out.headers["Content-Type"]).toBe(REDACTED);
    expect(out.headers.nested["X-Trace"]).toBe(REDACTED);
  });

  it("redacts the whole subtree under a secret key but keeps its shape", () => {
    const input = {
      oauthAccount: { emailAddress: "someone@example.test" },
      credentials: { accountUuid: "0000-1111", scopes: ["read", "write"] },
    };
    const out = redactDeep(input);
    expect(out.credentials.accountUuid).toBe(REDACTED);
    expect(out.credentials.scopes).toEqual([REDACTED, REDACTED]);
    expect(Object.keys(out.credentials)).toEqual(["accountUuid", "scopes"]);
  });

  it("walks arrays of objects", () => {
    const input = {
      servers: [
        { name: "one", token: "one-secret" },
        { name: "two", token: "two-secret" },
      ],
    };
    const out = redactDeep(input);
    expect(out.servers.map((server) => server.name)).toEqual(["one", "two"]);
    expect(out.servers.map((server) => server.token)).toEqual([
      REDACTED,
      REDACTED,
    ]);
  });

  it("redacts credentials inside an args vector", () => {
    const input = { command: "npx", args: ["run", "--api-key", "abc-invented"] };
    const out = redactDeep(input);
    expect(out.args).toEqual(["run", "--api-key", REDACTED]);
  });

  it("argument-scans an args vector that also holds non-strings", () => {
    // A single unquoted number must not switch argument scanning off; an
    // unquoted port in a config file is enough to trigger that.
    const out = redactDeep({ args: ["--port", 3000, "--api-key", "LIVE-key"] });
    expect(out.args).toEqual(["--port", 3000, "--api-key", REDACTED]);
  });

  it("preserves key order and object shape, dropping no keys", () => {
    const input = {
      zeta: 1,
      apiKey: "invented",
      alpha: { second: "b", token: "invented", first: "a" },
      middle: [1, 2, 3],
    };
    const out = redactDeep(input);
    expect(Object.keys(out)).toEqual(["zeta", "apiKey", "alpha", "middle"]);
    expect(Object.keys(out.alpha)).toEqual(["second", "token", "first"]);
    expect(out.middle).toEqual([1, 2, 3]);
    expect(Array.isArray(out.middle)).toBe(true);
  });

  it("copies instead of mutating, and the copy really differs", () => {
    const input = { apiKey: "still-here", env: { ANY: "still-here" } };
    const out = redactDeep(input);
    expect(input.apiKey).toBe("still-here");
    expect(input.env.ANY).toBe("still-here");
    expect(out).not.toBe(input);
    expect(out.env).not.toBe(input.env);
    expect(out).toEqual({ apiKey: REDACTED, env: { ANY: REDACTED } });
  });

  it("terminates on a cyclic object without throwing", () => {
    type Node = { name: string; token: string; self?: Node; child?: Node };
    const root: Node = { name: "root", token: "invented" };
    const child: Node = { name: "child", token: "invented", self: root };
    root.child = child;
    root.self = root;

    const out = redactDeep(root);
    expect(out.name).toBe("root");
    expect(out.token).toBe(REDACTED);
    expect(out.child?.name).toBe("child");
    expect(typeof out.self).toBe("string");
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("handles a cyclic array without hanging", () => {
    const arr: unknown[] = ["first"];
    arr.push(arr);
    expect(() => redactDeep(arr)).not.toThrow();
    expect(redactDeep(arr)[0]).toBe("first");
  });

  it("stays cheap on a shared-reference graph", () => {
    // Twenty-two levels of a diamond: only 23 distinct objects, but 4 million
    // paths through them. Visiting each object once keeps this instant.
    let node: Record<string, unknown> = { leaf: "value", token: "invented" };
    for (let depth = 0; depth < 22; depth += 1) {
      node = { left: node, right: node };
    }
    const startedAt = Date.now();
    const out = redactDeep(node);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    // A shared input node is one shared copy in the output, which is what makes
    // the walk linear.
    expect(out.left).toBe(out.right);
  });

  it("passes primitives and null through untouched", () => {
    expect(redactDeep("plain")).toBe("plain");
    expect(redactDeep(7)).toBe(7);
    expect(redactDeep(null)).toBeNull();
  });
});

describe("redactDeep - inputs the module does not model", () => {
  it("inspects a class instance instead of handing it back by reference", () => {
    class Holder {
      apiKey = "LIVE-credential";
      label = "visible";
    }
    const holder = new Holder();
    const out = redactDeep({ cfg: holder });
    expect(out.cfg).not.toBe(holder);
    expect(JSON.stringify(out)).not.toContain("LIVE-credential");
    expect(out.cfg).toEqual({ apiKey: REDACTED, label: "visible" });
  });

  it("replaces an object it cannot walk rather than aliasing it", () => {
    const when = new Date(1700000000000);
    const store = new Map([["apiKey", "LIVE-credential"]]);
    const out = redactDeep({ when, store });
    expect(out.when).not.toBe(when);
    expect(out.store).not.toBe(store);
    expect(typeof out.when).toBe("string");
    expect(typeof out.store).toBe("string");
  });

  it("replaces a function rather than aliasing it into the result", () => {
    const build = (): string => "LIVE-credential";
    const out = redactDeep({ build });
    expect(out.build).not.toBe(build);
    expect(typeof out.build).toBe("string");
  });

  it("keeps a __proto__ key as an own property without swapping a prototype", () => {
    const input = JSON.parse(
      String.raw`{"visible":"v","__proto__":{"url":"https://u:LIVE-credential@h/x"}}`,  // pii-allow: synthetic credential this test asserts is redacted
    ) as Record<string, unknown>;
    const out = redactDeep(input);
    expect(Object.keys(out)).toEqual(["visible", "__proto__"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.stringify(out)).not.toContain("LIVE-credential");
    // The payload must not become reachable as an inherited property either.
    expect((out as { url?: string }).url).toBeUndefined();
  });

  it("stops at a depth marker instead of exhausting the call stack", () => {
    // The walk recurses, so without a depth limit a pathologically nested input
    // throws RangeError, which a route would surface as a 500. A marker keeps the
    // failure legible and in the same shape as a cycle or an opaque object.
    let nested: Record<string, unknown> = { apiKey: "LIVE-credential" };
    for (let level = 0; level < 5000; level++) nested = { inner: nested };

    const out = redactDeep(nested);
    let cursor: unknown = out;
    let depth = 0;
    while (cursor !== null && typeof cursor === "object" && "inner" in cursor) {
      cursor = (cursor as { inner: unknown }).inner;
      depth++;
    }
    expect(typeof cursor).toBe("string");
    expect(cursor).toBe("[too deep]");
    expect(depth).toBeLessThan(5000);
    expect(JSON.stringify(out)).not.toContain("LIVE-credential");
  });

  it("keeps ordinary nesting well clear of the depth limit", () => {
    let nested: Record<string, unknown> = { apiKey: "LIVE-credential", label: "leaf" };
    for (let level = 0; level < 40; level++) nested = { inner: nested };
    expect(JSON.stringify(redactDeep(nested))).toContain("leaf");
    expect(JSON.stringify(redactDeep(nested))).not.toContain("[too deep]");
  });
});

describe("a credential under a key no pattern was written for", () => {
  it("redacts a trailing session credential such as AWS_SESSION", () => {
    // Reported as a live bypass: the value sat under a container called
    // "settings", which is not an opaque block, so only the key name could catch
    // it. Safe as a whole word because matching reads the last word only.
    const out = redactDeep({
      mcpServers: { widget: { settings: { AWS_SESSION: "LIVE-credential" } } },
    });
    expect(JSON.stringify(out)).not.toContain("LIVE-credential");
  });

  it("keeps the session fields this app renders in its own pillars", () => {
    // These are read straight out of the transcript and live-session readers. If
    // the word "session" matched anywhere in a key rather than at the end, every
    // one of them would blank and the sessions pillar would render empty rows.
    const out = redactDeep({
      sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
      liveSessionsDir: "/home/someone/.claude/sessions",  // pii-allow: generic placeholder path asserted NOT to be redacted
      sessionKeyIsFull: true,
      sessionsScanned: 30,
      titleSource: "ai-title",
    });
    expect(out).toEqual({
      sessionId: "aaaaaaaa-1111-2222-3333-444444444444",
      liveSessionsDir: "/home/someone/.claude/sessions",  // pii-allow: generic placeholder path asserted NOT to be redacted
      sessionKeyIsFull: true,
      sessionsScanned: 30,
      titleSource: "ai-title",
    });
  });
});

describe("credentials carried inside a string value", () => {
  it("redacts the password half of a URL userinfo section", () => {
    const out = redactDeep({ url: "https://admin:Tr0ub4dor@int.example/mcp" });  // pii-allow: synthetic credential this test asserts is redacted
    expect(out.url).toBe(`https://admin:${REDACTED}@int.example/mcp`);  // pii-allow: synthetic credential this test asserts is redacted
  });

  it("redacts the password in a connection string", () => {
    const out = redactDeep({ connectionString: "postgres://u:LIVE@db:5432/app" });
    expect(out.connectionString).toBe(`postgres://u:${REDACTED}@db:5432/app`);
  });

  it("redacts a secret-shaped query parameter and keeps the endpoint", () => {
    const out = redactDeep({ url: "https://api.example/mcp?access_token=LIVE" });
    expect(out.url).toBe(`https://api.example/mcp?access_token=${REDACTED}`);
  });

  it("leaves an ordinary URL and its ordinary parameters readable", () => {
    const url = "https://api.example/mcp?region=us-east-1&pageSize=50";
    expect(redactDeep({ url }).url).toBe(url);
  });

  it("redacts an inline credential inside an argument vector too", () => {
    const out = redactCommandArgs(["--url", "https://admin:Tr0ub4dor@h/mcp"]);  // pii-allow: synthetic credential this test asserts is redacted
    expect(out).toEqual(["--url", `https://admin:${REDACTED}@h/mcp`]);  // pii-allow: synthetic credential this test asserts is redacted
  });
});

describe("redactCommandArgs", () => {
  it("redacts the value after a secret flag (--flag VALUE form)", () => {
    expect(redactCommandArgs(["--api-key", "invented-value"])).toEqual([
      "--api-key",
      REDACTED,
    ]);
    expect(
      redactCommandArgs(["serve", "--token", "invented", "--port", "8080"]),
    ).toEqual(["serve", "--token", REDACTED, "--port", "8080"]);
  });

  it("redacts the value glued to a secret flag (--flag=VALUE form)", () => {
    expect(redactCommandArgs(["--token=invented-value"])).toEqual([
      `--token=${REDACTED}`,
    ]);
    expect(redactCommandArgs(["--client-secret=invented"])).toEqual([
      `--client-secret=${REDACTED}`,
    ]);
  });

  it("redacts the value after credential flags beyond the obvious ones", () => {
    expect(redactCommandArgs(["--pass", "invented"])).toEqual([
      "--pass",
      REDACTED,
    ]);
    expect(redactCommandArgs(["--passphrase", "invented"])).toEqual([
      "--passphrase",
      REDACTED,
    ]);
    expect(redactCommandArgs(["--jwt", "invented"])).toEqual([
      "--jwt",
      REDACTED,
    ]);
  });

  it("keeps a non-secret flag and its value readable", () => {
    const args = ["-y", "@invented/mcp-server", "--transport", "stdio"];
    expect(redactCommandArgs(args)).toEqual(args);
  });

  it("redacts an environment assignment passed as an argument", () => {
    // The docker-based MCP shape: the credential rides in as `-e NAME=VALUE`.
    expect(redactCommandArgs(["-e", "GITHUB_TOKEN=ghp_LIVE"])).toEqual([
      "-e",
      `GITHUB_TOKEN=${REDACTED}`,
    ]);
    expect(redactCommandArgs(["--env", "API_KEY=LIVE"])).toEqual([
      "--env",
      `API_KEY=${REDACTED}`,
    ]);
    // An env block is opaque wherever it appears, so the value goes even when
    // the variable name says nothing.
    expect(redactCommandArgs(["-e", "OPAQUE_BLOB=LIVE"])).toEqual([
      "-e",
      `OPAQUE_BLOB=${REDACTED}`,
    ]);
  });

  it("keeps a bare -e NAME pass-through readable", () => {
    // `-e NAME` with no `=` forwards an already-set variable; there is no value
    // in the vector to hide, and the name is what the reader needs.
    expect(redactCommandArgs(["-e", "GITHUB_TOKEN", "node"])).toEqual([
      "-e",
      "GITHUB_TOKEN",
      "node",
    ]);
  });

  it("redacts a bare NAME=VALUE assignment with a secret-shaped name", () => {
    expect(
      redactCommandArgs(["API_KEY=hunter2", "node", "server.js"]),
    ).toEqual([`API_KEY=${REDACTED}`, "node", "server.js"]);
    expect(redactCommandArgs(["LOG_LEVEL=debug"])).toEqual(["LOG_LEVEL=debug"]);
  });

  it("redacts a credential carried in a header argument", () => {
    expect(
      redactCommandArgs(["--header", "Authorization: Bearer invented-token"]),
    ).toEqual(["--header", `Authorization: ${REDACTED}`]);
    expect(redactCommandArgs(["--header", "X-Api-Key: invented-key"])).toEqual([
      "--header",
      `X-Api-Key: ${REDACTED}`,
    ]);
    expect(
      redactCommandArgs(["--header", "Content-Type: application/json"]),
    ).toEqual(["--header", "Content-Type: application/json"]);
  });

  it("treats an underscored header name the same as the object-key path", () => {
    expect(isSecretKey("HTTP_AUTHORIZATION")).toBe(true);
    expect(
      redactCommandArgs(["--header", "HTTP_AUTHORIZATION: sk-LIVE"]),
    ).toEqual(["--header", `HTTP_AUTHORIZATION: ${REDACTED}`]);
  });

  it("redacts a header whose name only mentions a credential mid-name", () => {
    expect(
      redactCommandArgs(["--header", "X-Custom-Auth-Value: LIVE"]),
    ).toEqual(["--header", `X-Custom-Auth-Value: ${REDACTED}`]);
    expect(redactCommandArgs(["--header", "X-Token-Header: LIVE"])).toEqual([
      "--header",
      `X-Token-Header: ${REDACTED}`,
    ]);
  });

  it("redacts a credential inside a multi-setting argument", () => {
    expect(
      redactCommandArgs([
        "--connect",
        "host=db user=admin password=Aa1Bb2Cc3Dd4Ee5Ff6",
      ]),
    ).toEqual(["--connect", `host=db user=admin password=${REDACTED}`]);
  });

  it("redacts a bare bearer token argument", () => {
    expect(redactCommandArgs(["Bearer invented-token-value"])).toEqual([
      `Bearer ${REDACTED}`,
    ]);
  });

  it("redacts a ${VAR} reference naming a secret-shaped variable", () => {
    expect(redactCommandArgs(["${SOME_ACCESS_KEY}"])).toEqual([REDACTED]);
    expect(redactCommandArgs(["--header=Authorization: ${MY_AUTH_TOKEN}"])).toEqual(
      [`--header=Authorization: ${REDACTED}`],
    );
    expect(redactCommandArgs(["$SOME_ACCESS_KEY"])).toEqual([REDACTED]);
  });

  it("redacts a ${VAR:-default} form including its literal fallback", () => {
    expect(redactCommandArgs(["${API_KEY:-hunter2Aa1Bb2}"])).toEqual([REDACTED]);
    expect(redactCommandArgs(["${API_KEY:?missing}"])).toEqual([REDACTED]);
  });

  it("leaves a ${VAR} reference for a non-secret variable readable", () => {
    expect(redactCommandArgs(["--root", "${PROJECT_ROOT}"])).toEqual([
      "--root",
      "${PROJECT_ROOT}",
    ]);
    expect(redactCommandArgs(["${PROJECT_ROOT:-/opt/app}"])).toEqual([
      "${PROJECT_ROOT:-/opt/app}",
    ]);
  });

  it("redacts a long random-looking argument with no flag to hint at it", () => {
    expect(redactCommandArgs(["connect", "sk-inv-Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8"])).toEqual(
      ["connect", REDACTED],
    );
    expect(redactCommandArgs(["AKIAIOSFODNN7EXAMPLE"])).toEqual([REDACTED]);  // pii-allow: AWS's own documented example key id
  });

  it("does not mistake ordinary long arguments for secrets", () => {
    const args = [
      "@invented-scope/server-filesystem",
      "/home/operator/repos/agentic-os",  // pii-allow: generic placeholder path asserted NOT to be redacted
      "2026-07-26-session-notes.md",
      "claude-opus-5-20260514",
      "550e8400-e29b-41d4-a716-446655440000",
    ];
    expect(redactCommandArgs(args)).toEqual(args);
  });

  it("does not redact timestamps, shas and digests", () => {
    const args = [
      "--out",
      "20260726T142211Z-session-notes.md",
      "--rev",
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4",  // pii-allow: synthetic hash asserted NOT to be redacted
      "--image",
      "registry.example/tool@sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",  // pii-allow: synthetic digest asserted NOT to be redacted
      "--cache",
      "/var/cache/blobs/3f786850e387550fdab836ed7e6dc881de23001b/data",  // pii-allow: synthetic hash asserted NOT to be redacted
    ];
    expect(redactCommandArgs(args)).toEqual(args);
  });

  it("rewrites the vector rather than handing back the input", () => {
    const args = ["--api-key", "invented"];
    const out = redactCommandArgs(args);
    expect(out).not.toBe(args);
    expect(out).toEqual(["--api-key", REDACTED]);
    expect(args).toEqual(["--api-key", "invented"]);
    expect(redactCommandArgs([])).toEqual([]);
  });

  it("redacts a dash-leading value after a secret flag", () => {
    // base64url credentials legitimately begin with `-`, so only an
    // unmistakable flag shape is read as the next flag rather than a value.
    expect(redactCommandArgs(["--api-key", "-Ab1Cc2Dd"])).toEqual([
      "--api-key",
      REDACTED,
    ]);
    expect(redactCommandArgs(["--token", "-_x9Zq"])).toEqual([
      "--token",
      REDACTED,
    ]);
  });

  it("does not consume a following flag as a secret flag's value", () => {
    expect(redactCommandArgs(["--token", "--verbose"])).toEqual([
      "--token",
      "--verbose",
    ]);
    expect(redactCommandArgs(["--token", "-v", "--port", "80"])).toEqual([
      "--token",
      "-v",
      "--port",
      "80",
    ]);
  });
});

describe("module surface", () => {
  it("exports no shallow redactor that could be mistaken for the deep one", () => {
    // A shallow per-key helper returns nested credentials untouched, and under a
    // near-synonymous name it is the easy mistake to make at a call site.
    expect(Object.keys(redactModule)).not.toContain("redactValue");
  });
});
