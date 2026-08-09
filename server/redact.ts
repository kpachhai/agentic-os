/**
 * Redaction of credentials out of operator configuration before it is rendered.
 *
 * Configuration files on a real machine carry live secrets: an MCP server
 * definition can pass an access key as a command-line header argument, set it in
 * an env block, hand it over as `-e NAME=VALUE`, or glue it into a URL, and a
 * Claude config backup contains an OAuth account object. Anything read out of
 * those files goes through here first.
 *
 * Both failure directions are bugs. Under-redaction leaks a working credential
 * to whatever renders the value; over-redaction blanks out ordinary settings and
 * makes the view useless. Three rules hold the balance, and the tests pin all
 * three:
 *
 *  - Key matching happens on whole words, so `keyRoots` and `tokenCount` stay
 *    readable while `apiKey` and `access_token` do not.
 *  - Only a string is ever replaced. A number, boolean, null or undefined cannot
 *    carry credential material, so replacing one hides nothing while destroying
 *    data worth reading: token counts, a `hasKey: true` flag.
 *  - An input shape this module cannot model is handled conservatively instead of
 *    being passed through. An argument vector is scanned whatever non-strings it
 *    also holds, and an object that is not plain data is never returned by
 *    reference.
 *
 * Pure and synchronous: no I/O, no dependencies, and the input is never mutated.
 *
 * THIS IS DEFENSE IN DEPTH, NOT THE PRIMARY CONTROL. Matching credentials by key
 * name can never be complete, because a config file may name one anything: a
 * secret written as `AWS_SESSION` under a container called `settings` matches no
 * pattern here worth writing, since the patterns broad enough to catch it would
 * blank out ordinary settings too. So a renderer that shows configuration must
 * choose the fields it displays from an allowlist and pass those through here,
 * rather than handing over a whole parsed config and trusting this module to
 * subtract the dangerous parts. Redaction catches what an allowlist forgot; it is
 * not a substitute for having one.
 */

/** Replacement for any redacted value; deliberately unmistakable for real data. */
export const REDACTED = "[REDACTED]";

/**
 * Stand-in for a container that references itself. Emitted instead of recursing
 * again, so a cyclic input terminates and the result stays serializable.
 */
const CIRCULAR = "[circular]";

/**
 * Stand-in for an object whose contents this module cannot reach: a Date, a Map,
 * a Set, anything holding its state behind accessors or internal slots. Such a
 * value is never handed back as-is, because passing an uninspected object
 * through is exactly how a credential escapes; emitting a marker says plainly
 * that something was there without guessing at what.
 */
export const UNSUPPORTED = "[unsupported value]";

/**
 * Words that name a credential. Multi-word keys are matched word by word, so
 * only whole words belong here. The run-together spellings at the end are
 * included because configuration files really do write `apikey` and
 * `accesstoken` with no separator, and word splitting cannot see inside those.
 *
 * Plurals such as `tokens` are safe to list only because a non-string value is
 * never replaced: `totalTokens: 1340` stays readable, and `pass: true` in a
 * pass/fail record stays readable, while a string under either name does not.
 */
const SECRET_WORDS = new Set([
  "key",
  "keys",
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwords",
  "passwd",
  "pwd",
  "pass",
  "passphrase",
  "passphrases",
  "credential",
  "credentials",
  "creds",
  "authorization",
  "auth",
  "bearer",
  "cookie",
  "cookies",
  "signature",
  "signatures",
  "jwt",
  "pat",
  "apikey",
  "apisecret",
  "apitoken",
  "accesskey",
  "accesstoken",
  "authtoken",
  "bearertoken",
  "clientsecret",
  "privatekey",
  "refreshtoken",
  "secretkey",
  "sessionkey",
  // A bare trailing "session" names a session credential in the wild, most
  // visibly in AWS_SESSION. It is safe as a whole word because matching is on
  // the LAST word only: sessionId keeps its value (last word "id"), and so do
  // liveSessionsDir and sessionKeyIsFull, all of which this app renders.
  "session",
  "sessions",
]);

/**
 * Split a key into its words so matching never fires on a fragment inside a
 * longer word. Handles camelCase, PascalCase, SCREAMING_SNAKE, snake_case,
 * kebab-case and dotted keys. Digits are split off and then dropped, so a
 * suffixed key such as `apiKey2` still ends on the word `key`.
 */
function splitKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word.length > 0 && !/^\d+$/.test(word));
}

/**
 * True when a key names a credential.
 *
 * The rule is that the LAST word of the key must be a secret word, which is
 * what separates a key holding a secret from a key describing one. `apiKey`,
 * `access_token` and `CLIENT_SECRET` all end on the secret word and are
 * redacted. `keyRoots` and `tokenCount` do not: there the secret word qualifies
 * something else, and their values are directory lists and counts worth seeing.
 * `keyboard`, `tokenizer`, `monkey` and `secretary` are single words that are
 * not secret words at all, so they never match either.
 */
export function isSecretKey(key: string): boolean {
  const words = splitKeyWords(key);
  const lastWord = words[words.length - 1];
  return lastWord !== undefined && SECRET_WORDS.has(lastWord);
}

/**
 * True when ANY word of a name is a secret word. Used for header names only.
 *
 * A header name is a flat label, not a key path, so the last-word rule does not
 * fit it: `X-Custom-Auth-Value` and `X-Token-Header` end on a qualifier and the
 * credential is still the value. Widening the rule this way is safe for headers
 * because no ordinary header name (`Content-Type`, `Cache-Control`, `Keep-Alive`,
 * `X-Request-Id`) contains one of these words at all.
 */
function namesCredentialAnywhere(name: string): boolean {
  return splitKeyWords(name).some((word) => SECRET_WORDS.has(word));
}

/**
 * Keys whose whole contents are credentials. In MCP configuration these blocks
 * hold secrets under arbitrary names chosen by the server author, so no
 * key-name pattern can find them; the only safe reading is that every string
 * inside is sensitive.
 */
const OPAQUE_CONTAINER_KEYS = new Set(["env", "headers"]);

/** Keys holding a command-line argument vector, which gets argument-aware redaction. */
const ARGUMENT_LIST_KEYS = new Set(["args"]);

/**
 * Flags that introduce an environment assignment on a command line, the shape a
 * container-hosted MCP server uses (`docker run -e NAME=VALUE ...`). The value
 * that follows is treated the way an `env` block is treated: opaque.
 */
const ENV_ASSIGNMENT_FLAGS = new Set(["-e", "--env"]);

/**
 * True for objects with plain data semantics, which is all that parsed JSON
 * configuration can contain. Class instances, Dates and Maps are excluded so
 * they can be handled conservatively instead of being copied key by key as if
 * they were records.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Attach a copied property as an own data property.
 *
 * Plain assignment would route a `__proto__` key into Object.prototype's setter,
 * which drops the key from the copy and replaces the copy's prototype with the
 * walked payload - leaving the unredacted original readable through the copy by
 * property access and for..in. defineProperty has no such side effect, and it is
 * what keeps `__proto__` visible in the copy like any other key.
 */
function defineOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * How a node was reached. The same node can be walked plainly, walked inside an
 * opaque block, or scanned as an argument vector, and the three produce
 * different output, so results are remembered per mode.
 */
type WalkMode = "plain" | "opaque" | "arguments";

/**
 * State for one top-level call. `ancestors` holds the containers currently open
 * on the walk path, which is how a cycle is detected. `finished` remembers the
 * copy already produced for a node, which is what keeps a shared-reference graph
 * linear: without it, a diamond of 23 objects nested 22 deep is walked four
 * million times.
 */
interface WalkContext {
  readonly ancestors: Set<object>;
  readonly finished: Map<object, Map<WalkMode, unknown>>;
}

function newWalkContext(): WalkContext {
  return { ancestors: new Set<object>(), finished: new Map() };
}

/**
 * Deepest nesting this module will walk into. The walk is recursive, so without a
 * limit a pathologically nested input exhausts the call stack and throws, which
 * would surface as a 500 from whatever route was rendering configuration. A
 * marker is the better failure: the reader learns that something was there and
 * was not inspected, which is the same contract as a cycle or an opaque object.
 *
 * Parsed configuration does not come close to this; real files nest single
 * digits deep.
 */
const MAX_DEPTH = 200;

/**
 * Stand-in for a subtree deeper than MAX_DEPTH. Distinct from UNSUPPORTED so the
 * cause is legible: nothing about the value was rejected, the walk simply
 * stopped.
 */
export const TOO_DEEP = "[too deep]";

/** Walk a container once per mode, returning CIRCULAR if it is already open. */
function walkOnce(
  context: WalkContext,
  node: object,
  mode: WalkMode,
  produce: () => unknown,
): unknown {
  if (context.ancestors.has(node)) return CIRCULAR;
  // ancestors holds exactly the containers open on the current path, so its size
  // is the current depth; no separate counter needs maintaining.
  if (context.ancestors.size >= MAX_DEPTH) return TOO_DEEP;

  let byMode = context.finished.get(node);
  if (byMode === undefined) {
    byMode = new Map<WalkMode, unknown>();
    context.finished.set(node, byMode);
  }
  if (byMode.has(mode)) return byMode.get(mode);

  context.ancestors.add(node);
  const copy = produce();
  context.ancestors.delete(node);
  byMode.set(mode, copy);
  return copy;
}

/**
 * Copy a value, redacting credentials at every depth.
 *
 * `redactEverything` is set once the walk enters a block whose entire contents
 * are secret, and stays set for the rest of that subtree.
 */
function walk(
  node: unknown,
  redactEverything: boolean,
  context: WalkContext,
): unknown {
  if (typeof node === "string") {
    return redactEverything ? REDACTED : redactInlineCredentials(node);
  }
  // A function is not configuration, cannot be inspected, and its closure can
  // hold anything, so it is replaced rather than aliased into the result.
  if (typeof node === "function") return UNSUPPORTED;
  // Only a string can be credential material, so every other primitive passes
  // through even under a secret-shaped key.
  if (node === null || typeof node !== "object") return node;

  const mode: WalkMode = redactEverything ? "opaque" : "plain";
  return walkOnce(context, node, mode, () =>
    Array.isArray(node)
      ? node.map((item) => walk(item, redactEverything, context))
      : copyRecord(node, redactEverything, context),
  );
}

/**
 * Copy an object property by property.
 *
 * Own enumerable string-keyed properties are all this can see, which is exactly
 * a plain record's contents and also covers a class instance used as a config
 * holder. An object that is not a plain record and exposes none of them keeps
 * its state somewhere unreachable, so it collapses to UNSUPPORTED rather than
 * coming back as a convincing-looking empty object.
 */
function copyRecord(
  node: object,
  redactEverything: boolean,
  context: WalkContext,
): unknown {
  const entries = Object.entries(node);
  if (entries.length === 0 && !isPlainRecord(node)) return UNSUPPORTED;

  // Rebuilding in Object.entries order keeps the reader's key order intact.
  const copy: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    defineOwn(copy, key, walkProperty(key, value, redactEverything, context));
  }
  return copy;
}

function walkProperty(
  key: string,
  value: unknown,
  redactEverything: boolean,
  context: WalkContext,
): unknown {
  if (redactEverything) return walk(value, true, context);

  const lowerKey = key.toLowerCase();
  // A secret key or an opaque block redacts its whole subtree. Recursing with
  // the flag set (rather than returning REDACTED outright) keeps the shape
  // visible, so a reader still sees which variables are set.
  if (OPAQUE_CONTAINER_KEYS.has(lowerKey) || isSecretKey(key)) {
    return walk(value, true, context);
  }
  if (ARGUMENT_LIST_KEYS.has(lowerKey) && Array.isArray(value)) {
    // Scanned whatever else the array holds: one unquoted number must not be
    // able to switch argument awareness off for the whole vector.
    return walkOnce(context, value, "arguments", () =>
      redactArgumentList(value, context),
    );
  }
  return walk(value, false, context);
}

/**
 * Copy a value with every credential replaced. Object shape and key order are
 * preserved and no own enumerable string key is ever dropped: the reader should
 * be able to see that a setting exists without seeing what it is.
 *
 * Nothing from the input is aliased into the result, and two limits are worth
 * stating rather than implying. A value reachable from several places in the
 * input is the same copied object at each of them, so shared structure survives
 * and the walk stays linear. A value that is not a plain object or array cannot
 * be reproduced: a class instance comes back as a plain object of its own
 * enumerable properties, an object with none of those (a Date, a Map, a Set) and
 * any function come back as UNSUPPORTED, and anything held under a symbol key or
 * a non-enumerable one is not copied at all. Parsed JSON configuration, which is
 * what this is for, has none of those.
 */
export function redactDeep<T>(value: T): T {
  return walk(value, false, newWalkContext()) as T;
}

/**
 * Split an assignment argument into its parts: `NAME=VALUE`, `-name=VALUE` or
 * `--name=VALUE`. The bare form matters as much as the flag forms, because
 * `GITHUB_TOKEN=ghp_...` and `API_KEY=...` are how a credential is handed to a
 * container-hosted MCP server. Underscores are part of a name, so a SCREAMING
 * SNAKE variable is recognised as one name rather than a truncated one.
 */
function splitAssignment(
  arg: string,
): { dashes: string; name: string; value: string } | null {
  const match = arg.match(/^(-{0,2})([A-Za-z_][A-Za-z0-9._-]*)=([\s\S]*)$/);
  if (!match) return null;
  const [, dashes = "", name = "", value = ""] = match;
  return { dashes, name, value };
}

function isFlag(arg: string): boolean {
  return /^-{1,2}[A-Za-z]/.test(arg);
}

function flagName(arg: string): string {
  return arg.replace(/^-+/, "");
}

/**
 * True for an argument that is unmistakably another flag rather than the value a
 * secret flag was waiting for.
 *
 * Deliberately narrow. A base64url credential can begin with `-`, so treating
 * every dash-leading argument as a flag leaks keys such as `-Ab1Cc2Dd`. Only a
 * lowercase long flag (`--verbose`, `--dry-run`) or a single-letter short flag
 * (`-v`) is read as a flag here; anything else following a secret flag is
 * redacted. The trade is deliberate: a secret flag left without a value hides
 * one harmless argument, which is cheaper than printing a live key.
 */
function looksLikeSeparateFlag(arg: string): boolean {
  return /^--[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(arg) || /^-[A-Za-z]$/.test(arg);
}

/**
 * Entropy proxy for a credential pasted straight onto a command line, used only
 * when nothing else names the argument as a secret.
 *
 * A credential body is a long unbroken alphanumeric run mixing several letters
 * with at least one digit: an API key body, an AWS access key id, a JWT segment.
 * Human-readable arguments break every few characters at a hyphen, slash or dot,
 * so a package name, a file path or a model id never reaches the run length.
 * Two shapes that do reach it are excluded, because blanking them hides ordinary
 * output and neither is a secret:
 *
 *  - runs with fewer than four letters, which is what a compact timestamp
 *    (`20260726T142211Z`) or a long numeric id looks like;
 *  - hex-only runs of digest length, which is a git sha, an image digest or a
 *    content-addressed cache segment.
 *
 * The cost of the second exclusion is that a hex-only credential of digest
 * length is missed here. It is still redacted whenever it appears under a
 * secret-shaped key, flag, header or assignment, which is how one is passed in
 * practice; a bare hex blob on a command line is far more often a hash.
 */
function looksLikeRandomSecret(token: string): boolean {
  for (const run of token.match(/[A-Za-z0-9]+/g) ?? []) {
    if (run.length < 16) continue;
    const letters = run.replace(/[^A-Za-z]/g, "").length;
    if (letters < 4 || letters === run.length) continue;
    if (run.length >= 32 && /^[0-9a-f]+$/i.test(run)) continue;
    return true;
  }
  return false;
}

/**
 * Redact credential material carried inside a string value, keeping the rest
 * readable: the password half of a URL userinfo section, and query parameters
 * whose own name names a credential. Which endpoint is configured is the reason
 * to show the value at all, so the scheme, host and path stay.
 *
 * This runs on every string the walk passes, not just on arguments, because a
 * connection string or an MCP URL carries its credential in the value and no key
 * name can reveal it.
 */
function redactInlineCredentials(value: string): string {
  const withoutUserinfo = value.replace(
    /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^\s:/?#@]+):([^\s/?#@]+)@/g,
    (_whole, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`,
  );
  return withoutUserinfo.replace(
    /([?&])([A-Za-z_][A-Za-z0-9_.-]*)=([^&#\s]+)/g,
    (whole, lead: string, name: string) =>
      isSecretKey(name) ? `${lead}${name}=${REDACTED}` : whole,
  );
}

/**
 * Redact one token of an argument: a secret-shaped assignment loses its value
 * and keeps its name, and anything else is judged on shape alone.
 */
function redactArgumentToken(token: string): string {
  const assignment = splitAssignment(token);
  if (assignment !== null && isSecretKey(assignment.name)) {
    return `${assignment.dashes}${assignment.name}=${REDACTED}`;
  }
  return looksLikeRandomSecret(token) ? REDACTED : token;
}

/**
 * Redact credential material inside one argument, keeping the readable part so
 * the reader can still tell which header or variable carried it.
 */
function redactArgumentValue(value: string): string {
  // `Authorization: Bearer <key>` and `X-Api-Key: <key>`: the shape a
  // credential takes when it rides along as a header argument. Underscores
  // belong in the name, so `HTTP_AUTHORIZATION` is recognised here exactly as it
  // is on the object-key path.
  const header = value.match(/^([A-Za-z][A-Za-z0-9_-]*)(\s*:\s*)([\s\S]+)$/);
  if (header) {
    const [, headerName = "", separator = ""] = header;
    if (namesCredentialAnywhere(headerName)) {
      return `${headerName}${separator}${REDACTED}`;
    }
  }

  let out = value.replace(/\b(bearer\s+)\S+/gi, `$1${REDACTED}`);
  // A `${VAR}`, `${VAR:-default}` or `$VAR` reference naming a credential is
  // redacted whole: the variable name alone tells a reader which secret is being
  // handed over, and a shell default is a literal credential sitting in the
  // argument.
  out = out.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/g,
    (whole, name: string) => (isSecretKey(name) ? REDACTED : whole),
  );
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name: string) =>
    isSecretKey(name) ? REDACTED : whole,
  );
  out = redactInlineCredentials(out);

  // Judged token by token rather than declined on any whitespace: one argument
  // can carry several settings (`host=db user=admin password=...`), and the
  // readable ones stay readable while the credential goes.
  return out.replace(/\S+/g, redactArgumentToken);
}

/** What the previous argument said about the one now being read. */
type PendingArgument = "nothing" | "secretValue" | "envAssignment";

/**
 * Redact credentials from an argument vector, covering the shapes that show up
 * in real MCP server definitions: a secret passed as the value after a flag,
 * glued to the flag with `=`, given as a bare or `-e`-introduced environment
 * assignment, embedded in a header argument or a URL, or referenced through an
 * environment variable.
 *
 * Non-string elements are walked as ordinary values: one cannot be a credential,
 * and it also breaks the flag/value pairing, so it clears whatever the previous
 * argument set up rather than letting an expectation slide onto the next string.
 */
function redactArgumentList(
  items: readonly unknown[],
  context: WalkContext,
): unknown[] {
  const out: unknown[] = [];
  let pending: PendingArgument = "nothing";

  for (const item of items) {
    if (typeof item !== "string") {
      pending = "nothing";
      out.push(walk(item, false, context));
      continue;
    }

    const expected = pending;
    pending = "nothing";

    if (expected === "secretValue" && !looksLikeSeparateFlag(item)) {
      out.push(REDACTED);
      continue;
    }

    const assignment = splitAssignment(item);
    if (
      expected === "envAssignment" &&
      assignment !== null &&
      assignment.dashes === ""
    ) {
      // Everything an env block holds is treated as secret wherever the block
      // appears, so the value goes even when the variable name says nothing.
      // The name stays, so the reader sees which variable is set.
      out.push(`${assignment.name}=${REDACTED}`);
      continue;
    }
    if (assignment !== null) {
      const value = isSecretKey(assignment.name)
        ? REDACTED
        : redactArgumentValue(assignment.value);
      out.push(`${assignment.dashes}${assignment.name}=${value}`);
      continue;
    }

    if (ENV_ASSIGNMENT_FLAGS.has(item)) {
      // `-e NAME` with no `=` forwards an already-set variable; there is no
      // value in the vector to hide, so only an assignment is acted on.
      out.push(item);
      pending = "envAssignment";
      continue;
    }

    if (isFlag(item) && isSecretKey(flagName(item))) {
      // The flag name is not the secret; keep it readable and take the next one.
      out.push(item);
      pending = "secretValue";
      continue;
    }

    out.push(redactArgumentValue(item));
  }

  return out;
}

/**
 * Redact credentials from a command-line argument vector. Every element in and
 * every element out is a string, so this is the convenient entry point for a
 * caller that already has a string vector; the object walk uses the same logic
 * on `args` arrays whatever they hold.
 */
export function redactCommandArgs(args: string[]): string[] {
  return redactArgumentList(args, newWalkContext()) as string[];
}
