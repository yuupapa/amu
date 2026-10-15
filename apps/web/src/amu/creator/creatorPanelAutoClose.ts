/**
 * The right panel a Creator pop-out closed, per thread. Popping out closes the
 * thread's panel once and marks the thread; the mark is what lets the last
 * Creator to come back reopen it. A panel the user opens again while marked is
 * theirs: the mark is dropped and nothing is closed or reopened for it.
 *
 * Marks persist, so a crash or restart with a window out (nothing is popped out
 * after it) still gets its panel back when the thread's Creator tab shows up.
 */
const STORAGE_KEY = "amu:creator-panel-auto-closed";

let memory: Set<string> | null = null;

const storage = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

const marks = (): Set<string> => {
  if (memory !== null) return memory;
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    memory = new Set(Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : []);
  } catch {
    memory = new Set();
  }
  return memory;
};

const save = (next: Set<string>) => {
  memory = next;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify([...next]));
  } catch {
    // Kept in memory for this session.
  }
};

export const creatorPanelMarks = {
  has: (threadKey: string): boolean => marks().has(threadKey),
  set: (threadKey: string): void => save(new Set([...marks(), threadKey])),
  clear: (threadKey: string): void => {
    if (!marks().has(threadKey)) return;
    const next = new Set(marks());
    next.delete(threadKey);
    save(next);
  },
  /** Tests only: forget the in-memory copy so the next read comes from storage. */
  reset: (): void => {
    memory = null;
  },
};

export type CreatorPanelStep = "close" | "reopen" | "forget" | null;

/** A Creator tab of the thread just moved into its own window. */
export function creatorPoppedOutStep(input: {
  readonly panelOpen: boolean;
  readonly marked: boolean;
}): CreatorPanelStep {
  if (!input.panelOpen) return null;
  // Open while marked: the user reopened it after an earlier pop-out.
  return input.marked ? "forget" : "close";
}

/**
 * A Creator tab of the thread is back in the panel, or showed up not popped out
 * (after a restart). Reopens only a panel still closed by a pop-out, and only
 * once no other Creator of the thread is out.
 */
export function creatorReturnedStep(input: {
  readonly panelOpen: boolean;
  readonly marked: boolean;
  readonly otherPoppedOut: boolean;
}): CreatorPanelStep {
  if (!input.marked) return null;
  if (input.panelOpen) return "forget";
  return input.otherPoppedOut ? null : "reopen";
}
