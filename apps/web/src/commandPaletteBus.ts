import type { EnvironmentId, PullRequestLinkedThreadsResult } from "@t3tools/contracts";

import type { NewThreadSplit } from "./components/SplitWorkspace";

export interface CommandPaletteLinkedThreads {
  readonly environmentId: EnvironmentId;
  readonly threads: PullRequestLinkedThreadsResult["threads"];
}

// Tiny event bus allowing components to programmatically open the command palette
// without owning its React state.
const COMMAND_PALETTE_OPEN_EVENT = "t3code:open-command-palette";

export interface CommandPaletteOpenDetail {
  readonly open?: "add-project" | "new-thread-in";
  readonly query?: string;
  readonly linkedThreads?: CommandPaletteLinkedThreads;
  /** With `open: "new-thread-in"`: the thread started from the picker opens split this way. */
  readonly newThreadSplit?: NewThreadSplit;
}

let pendingNewThreadSplit: NewThreadSplit | null = null;

/**
 * The split asked for when the palette was opened, handed out once to the
 * thread the picker starts. The palette drops it when it closes.
 */
export function takePendingNewThreadSplit(): NewThreadSplit | null {
  const split = pendingNewThreadSplit;
  pendingNewThreadSplit = null;
  return split;
}

export function openCommandPalette(detail?: CommandPaletteOpenDetail): void {
  pendingNewThreadSplit = detail?.newThreadSplit ?? null;
  window.dispatchEvent(
    new CustomEvent(COMMAND_PALETTE_OPEN_EVENT, detail ? { detail } : undefined),
  );
}

export function onOpenCommandPalette(
  listener: (detail: CommandPaletteOpenDetail) => void,
): () => void {
  const handler = (event: Event) => {
    listener((event as CustomEvent<CommandPaletteOpenDetail>).detail ?? {});
  };
  window.addEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
  return () => window.removeEventListener(COMMAND_PALETTE_OPEN_EVENT, handler);
}

/** Read at event time so consumers do not subscribe to transient dialog state. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
