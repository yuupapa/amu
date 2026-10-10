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

const byTab = new Map<string, CreatorAttention>();
const listeners = new Set<() => void>();

export function setCreatorAttention(runtimeTabId: string, attention: CreatorAttention | null) {
  if (attention === null ? !byTab.delete(runtimeTabId) : byTab.get(runtimeTabId) === attention) {
    return;
  }
  if (attention !== null) byTab.set(runtimeTabId, attention);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useCreatorAttention(runtimeTabId: string | null): CreatorAttention | null {
  const read = () => (runtimeTabId === null ? null : (byTab.get(runtimeTabId) ?? null));
  // Static rendering has no live sends to report.
  return useSyncExternalStore(subscribe, read, () => null);
}
