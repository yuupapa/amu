/**
 * A started Amu Creator send that needs the user (sending, stuck, halted or
 * conflict) whose confirm sheet is closed, per desktop preview tab. The session
 * host publishes it; the preview panel of that tab shows a banner that reopens
 * the sheet. Kept outside the guest page on purpose.
 */
import type { CreatorProposal } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

export interface CreatorAttention {
  readonly proposal: CreatorProposal;
  readonly open: () => void;
}

const byTab = new Map<string, { readonly holder: symbol; readonly attention: CreatorAttention }>();
const listeners = new Set<() => void>();

/**
 * Publishes or clears the tab's attention for `holder`, one per session runner.
 * The same thread open in two panes runs two runners for one tab; clearing only
 * removes the holder's own entry, so the non-owner cannot drop the owner's banner.
 */
export function setCreatorAttention(
  runtimeTabId: string,
  holder: symbol,
  attention: CreatorAttention | null,
) {
  const current = byTab.get(runtimeTabId);
  if (attention === null) {
    if (current?.holder !== holder) return;
    byTab.delete(runtimeTabId);
  } else {
    if (current?.holder === holder && current.attention === attention) return;
    byTab.set(runtimeTabId, { holder, attention });
  }
  for (const listener of listeners) listener();
}

export function readCreatorAttention(runtimeTabId: string): CreatorAttention | null {
  return byTab.get(runtimeTabId)?.attention ?? null;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useCreatorAttention(runtimeTabId: string | null): CreatorAttention | null {
  const read = () => (runtimeTabId === null ? null : readCreatorAttention(runtimeTabId));
  // Static rendering has no live sends to report.
  return useSyncExternalStore(subscribe, read, () => null);
}
