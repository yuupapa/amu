/** Tracks panels closed for an Amu window without reopening them when it closes. */
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

export type CreatorPanelStep = "close" | "forget" | null;

/** A Creator tab of the thread just moved into its own window. */
export function creatorPoppedOutStep(input: {
  readonly panelOpen: boolean;
  readonly marked: boolean;
}): CreatorPanelStep {
  if (!input.panelOpen) return null;
  // Open while marked: the user reopened it after an earlier pop-out.
  return input.marked ? "forget" : "close";
}

/** Closing a window (including after restart) only clears its old panel mark. */
export function creatorReturnedStep(input: {
  readonly panelOpen: boolean;
  readonly marked: boolean;
  readonly otherPoppedOut: boolean;
}): CreatorPanelStep {
  return input.marked && !input.otherPoppedOut ? "forget" : null;
}
