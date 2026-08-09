import { useEffect, useState } from "react";

/**
 * A configured data source is not on disk.
 *
 * This is deliberately its own type rather than a generic failure. "You have not
 * set this up yet" and "this is broken" are different claims, and rendering both
 * as an error made a fresh clone look like five broken pages when it was really
 * five unconfigured ones. The server already distinguishes them by answering 503
 * with the pillar and the path it looked for; the client has to carry that
 * distinction through to what the reader sees.
 */
export class SourceMissing extends Error {
  constructor(
    readonly pillar: string,
    readonly sourcePath: string,
  ) {
    super(`${pillar} source missing: ${sourcePath}`);
    this.name = "SourceMissing";
  }
}

type ErrorBody = { error?: string; pillar?: string; path?: string };

async function readErrorBody(res: Response): Promise<ErrorBody> {
  try {
    return (await res.json()) as ErrorBody;
  } catch {
    return {};
  }
}

async function raise(method: string, path: string, res: Response): Promise<never> {
  const body = await readErrorBody(res);
  if (res.status === 503 && body.error === "source missing") {
    throw new SourceMissing(body.pillar ?? "source", body.path ?? "unknown path");
  }
  throw new Error(
    `${method} ${path} -> ${res.status} ${(body.error ?? "").slice(0, 200)}`,
  );
}

/**
 * The last payload each path answered with, successes only.
 *
 * Only successes, because caching a 503 would freeze a pillar the operator has
 * just finished configuring, and "not set up yet" is exactly the answer most
 * likely to change between two loads. A failure therefore always goes to the
 * network, and it also drops whatever was remembered - see useApi.
 */
const payloads = new Map<string, unknown>();

/**
 * Requests currently on the wire, so a path asked for twice before the first
 * answer arrives costs one round trip rather than two. The whole-page views fan
 * out to several routes and a landing page fans out to more, so this is the
 * difference between one request per route and one per caller.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * Bumped by every write. A read that was already in flight when a write landed
 * describes the world before it, so its payload is dropped rather than
 * remembered: without this, a slow read started before an index sync could be
 * written into the cache after the sync cleared it and outlive the change.
 */
let epoch = 0;

/**
 * Minimal typed fetch helper for the local API. Throws on non-2xx, and always
 * resolves with a freshly read payload rather than a remembered one - the cache
 * feeds `useApi`'s first render, never this promise, so an existing caller cannot
 * be handed stale data by upgrading underneath it.
 *
 * `cache` opts a path out of both remembering and deduplication. Anything polled
 * for liveness has to pass false: a strip that repaints from a memo is a strip
 * that stopped being live, which is the one property it has.
 *
 * `signal` cancels one read, and a read that carries one is never shared with
 * another caller: aborting a deduplicated promise would abort it for everybody
 * waiting on it. Its result is still remembered on success, because a payload that
 * arrived is a payload that arrived.
 */
export async function apiGet<T>(
  path: string,
  opts: { cache?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const remember = opts.cache !== false;
  const read = async (): Promise<T> => {
    const res = await fetch(path, opts.signal ? { signal: opts.signal } : undefined);
    if (!res.ok) await raise("GET", path, res);
    return (await res.json()) as T;
  };

  if (!remember) return read();

  if (opts.signal) {
    const startedAt = epoch;
    const payload = await read();
    if (epoch === startedAt) payloads.set(path, payload);
    return payload;
  }

  const pending = inFlight.get(path);
  if (pending) return pending as Promise<T>;

  const startedAt = epoch;
  const request = read();
  inFlight.set(path, request);

  try {
    const payload = await request;
    if (epoch === startedAt) payloads.set(path, payload);
    return payload;
  } finally {
    // Only if it is still ours: a write clears the map, and a later request for
    // the same path may already have claimed the slot.
    if (inFlight.get(path) === request) inFlight.delete(path);
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await raise("POST", path, res);
  // A write is never cached and invalidates everything, because what it changed
  // is not knowable from its path: syncing the index changes what /api/search and
  // /api/index/stats both answer.
  epoch += 1;
  payloads.clear();
  inFlight.clear();
  return (await res.json()) as T;
}

/** What a view knows about one route right now. */
export type ApiState<T> = {
  /** The freshest payload available, which may be the previous one. */
  data: T | null;
  error: unknown;
  /** True while a read is on the wire, whether or not `data` is already filled. */
  loading: boolean;
};

function remembered<T>(path: string, remember: boolean): ApiState<T> {
  const previous = remember ? payloads.get(path) : undefined;
  return {
    data: previous === undefined ? null : (previous as T),
    error: null,
    loading: true,
  };
}

/**
 * Read one route, showing the last answer while the next one is fetched.
 *
 * Navigating back to a pillar used to unmount its view and refetch from nothing,
 * so every revisit paid the full round trip with a placeholder on screen. Here the
 * previous payload renders on the first frame and is replaced when the read lands,
 * which is why a view using this should still show its skeleton on `loading` only
 * when `data` is null.
 *
 * A failed read clears what was remembered rather than leaving it on screen. That
 * matters most for the case this whole distinction exists for: a source that has
 * gone missing must reach the reader as the first-run panel naming the path, and
 * numbers from before it went would say the opposite.
 */
export function useApi<T>(path: string, opts: { cache?: boolean } = {}): ApiState<T> {
  const remember = opts.cache !== false;
  const [state, setState] = useState<ApiState<T>>(() => remembered<T>(path, remember));

  useEffect(() => {
    let cancelled = false;
    setState(remembered<T>(path, remember));
    apiGet<T>(path, { cache: remember })
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        payloads.delete(path);
        setState({ data: null, error, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [path, remember]);

  return state;
}
