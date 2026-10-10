/**
 * Pacing for overlay -> main messages, so the panel stays inside main's per-guest
 * limits instead of having messages refused: comment messages (draft, update,
 * place, delete, confirm-by-user) share 2 per second, propose and cancel share
 * 1 per 2 seconds. Typing is debounced and sent at most once per second, which
 * leaves room for one button press in the same second.
 */
import type { DesktopPreviewCreatorGuestKind } from "@t3tools/contracts";

const COMMENT_MAX = 2;
const COMMENT_WINDOW_MS = 1_000;
const PROPOSE_INTERVAL_MS = 2_000;

/** Mirrors main's rate gates. `take` spends a slot only when it returns true. */
export const createRateBudget = () => {
  const commentTimes: number[] = [];
  let lastPropose = Number.NEGATIVE_INFINITY;
  return {
    take: (kind: DesktopPreviewCreatorGuestKind, now: number): boolean => {
      if (kind === "propose" || kind === "cancel") {
        if (now - lastPropose < PROPOSE_INTERVAL_MS) return false;
        lastPropose = now;
        return true;
      }
      while (commentTimes.length > 0 && now - (commentTimes[0] ?? 0) >= COMMENT_WINDOW_MS) {
        commentTimes.shift();
      }
      if (commentTimes.length >= COMMENT_MAX) return false;
      commentTimes.push(now);
      return true;
    },
  };
};

export type RateBudget = ReturnType<typeof createRateBudget>;

export const TYPING_QUIET_MS = 800;
export const TYPING_MIN_INTERVAL_MS = 1_000;
const RETRY_MS = 500;

type Entry = { value: string; readyAt: number; notBefore: number };

/**
 * Debounced sends keyed by card. A value goes out `TYPING_QUIET_MS` after its
 * last change (or at once on `flush`), and no two sends are closer than
 * `TYPING_MIN_INTERVAL_MS` across all keys. `send` returns false when it cannot
 * go yet (no budget, waiting for the server); the newest value is retried.
 */
export const createUpdateScheduler = (deps: {
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (handle: unknown) => void;
  readonly send: (key: string, value: string) => boolean;
}) => {
  const entries = new Map<string, Entry>();
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;

  const dueOf = (entry: Entry) => Math.max(entry.readyAt, entry.notBefore);
  const next = (): { key: string; entry: Entry } | null => {
    let best: { key: string; entry: Entry } | null = null;
    for (const [key, entry] of entries) {
      if (best === null || dueOf(entry) < dueOf(best.entry)) best = { key, entry };
    }
    return best;
  };
  const schedule = () => {
    if (timer !== null) deps.clearTimer(timer);
    timer = null;
    const first = next();
    if (first === null) return;
    const at = Math.max(dueOf(first.entry), lastSentAt + TYPING_MIN_INTERVAL_MS);
    const now = deps.now();
    if (at <= now) {
      fire();
      return;
    }
    timer = deps.setTimer(fire, at - now);
  };
  function fire() {
    timer = null;
    const now = deps.now();
    const first = next();
    if (first === null) return;
    if (dueOf(first.entry) <= now && lastSentAt + TYPING_MIN_INTERVAL_MS <= now) {
      if (deps.send(first.key, first.entry.value)) {
        lastSentAt = now;
        entries.delete(first.key);
      } else {
        first.entry.notBefore = now + RETRY_MS;
      }
    }
    schedule();
  }

  return {
    change: (key: string, value: string) => {
      const previous = entries.get(key);
      entries.set(key, {
        value,
        readyAt: deps.now() + TYPING_QUIET_MS,
        notBefore: previous?.notBefore ?? Number.NEGATIVE_INFINITY,
      });
      schedule();
    },
    /** Send the pending value as soon as the pacing allows (blur, before a send). */
    flush: (key: string) => {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entry.readyAt = deps.now();
      schedule();
    },
    cancel: (key: string) => {
      entries.delete(key);
      schedule();
    },
    /** A placeholder became a saved comment: its pending value now updates that comment. */
    rekey: (from: string, to: string) => {
      const entry = entries.get(from);
      if (entry === undefined) return;
      entries.delete(from);
      entries.set(to, entry);
    },
    pending: (key: string) => entries.has(key),
    clear: () => {
      entries.clear();
      schedule();
    },
  };
};

export type UpdateScheduler = ReturnType<typeof createUpdateScheduler>;
