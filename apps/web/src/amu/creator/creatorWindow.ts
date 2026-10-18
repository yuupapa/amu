/**
 * Amu Creator's own desktop window, as the web app drives it: the open and
 * return calls every entry point shares (toolbar, panel notice, chat chip), and
 * the tabs an agent just opened that should move into their window as soon as
 * their Creator session is live.
 */
import { useSyncExternalStore } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { toastManager } from "~/components/ui/toast";

export type CreatorWindowAction = "pop-out" | "return";

/**
 * Opens (or brings forward) the tab's Creator window, or returns its page to
 * the panel. Resolves false, after a toast, when the desktop refused.
 */
export async function runCreatorWindowAction(
  action: CreatorWindowAction,
  runtimeTabId: string,
  /** What the toasts call the tab: Amu Creator, or Amu Gallery's "ギャラリー". */
  appName = "Creator",
): Promise<boolean> {
  if (!previewBridge) return false;
  const operation =
    action === "pop-out" ? previewBridge.popOutCreator : previewBridge.returnCreator;
  try {
    await operation(runtimeTabId);
    return true;
  } catch (error) {
    toastManager.add({
      type: "error",
      title:
        action === "pop-out"
          ? `${appName}を別ウィンドウで開けませんでした`
          : `${appName}をパネルに戻せませんでした`,
      description: error instanceof Error ? error.message : "エラーが発生しました。",
    });
    return false;
  }
}

/** An agent-opened tab whose session never goes live within this long stays in the panel. */
const AUTO_POPOUT_TTL_MS = 60_000;

/** Pending requests; each drops itself when it expires, releasing what it held open. */
const autoPopouts = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

/** Drops the tab's pending request, if any (it expired, was taken, or the tab closed). */
export function clearCreatorAutoPopout(runtimeTabId: string): void {
  const expiry = autoPopouts.get(runtimeTabId);
  if (expiry === undefined) return;
  clearTimeout(expiry);
  autoPopouts.delete(runtimeTabId);
  notify();
}

/** Marks a tab an agent just opened to move into its own window once registered. */
export function requestCreatorAutoPopout(runtimeTabId: string): void {
  clearCreatorAutoPopout(runtimeTabId);
  autoPopouts.set(
    runtimeTabId,
    setTimeout(() => clearCreatorAutoPopout(runtimeTabId), AUTO_POPOUT_TTL_MS),
  );
  notify();
}

/** Takes the tab's pending request; false when there is none (or it already expired). */
export function takeCreatorAutoPopout(runtimeTabId: string): boolean {
  if (!autoPopouts.has(runtimeTabId)) return false;
  clearCreatorAutoPopout(runtimeTabId);
  return true;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function useCreatorAutoPopoutRequested(runtimeTabId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => autoPopouts.has(runtimeTabId),
    () => false,
  );
}
