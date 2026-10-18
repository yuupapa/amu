/**
 * Moves an Amu Gallery tab between the panel and its own window the way
 * `CreatorTabWatcher` does for Creator, without a Creator session:
 *
 * - A tab an agent just opened moves into its window once its page has loaded;
 *   if that fails it stays in the panel.
 * - Popping out closes the thread's right panel; coming back reopens it on this
 *   tab. A panel the user reopens meanwhile is left alone.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef } from "react";

import { readThreadPreviewState } from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import {
  creatorPanelMarks,
  creatorPoppedOutStep,
  creatorReturnedStep,
} from "../creator/creatorPanelAutoClose";
import {
  runCreatorWindowAction,
  takeCreatorAutoPopout,
  useCreatorAutoPopoutRequested,
} from "../creator/creatorWindow";

export function GalleryTabWatcher(props: {
  readonly threadRef: ScopedThreadRef;
  readonly serverTabId: string;
  readonly runtimeTabId: string;
  /** The gallery page finished loading in the tab's webview. */
  readonly loaded: boolean;
  readonly poppedOut: boolean;
  /** Whether the desktop has reported this tab yet; until then `poppedOut` is only a default. */
  readonly desktopKnown: boolean;
}) {
  const { threadRef, serverTabId, runtimeTabId, loaded, poppedOut, desktopKnown } = props;
  const autoPopout = useCreatorAutoPopoutRequested(runtimeTabId);

  // No clearing on unmount: React's development double mount would drop the
  // request before the page loads. A request expires on its own (60 s), and a
  // closed tab's id is never reused.
  const ready = desktopKnown && loaded;
  useEffect(() => {
    if (!autoPopout || !ready || !takeCreatorAutoPopout(runtimeTabId)) return;
    void runCreatorWindowAction("pop-out", runtimeTabId, "ギャラリー").then((opened) => {
      if (!opened) useRightPanelStore.getState().openBrowser(threadRef, serverTabId);
    });
  }, [autoPopout, ready, runtimeTabId, serverTabId, threadRef]);

  const shownPoppedOut = useRef<boolean | null>(null);
  useEffect(() => {
    if (!desktopKnown || shownPoppedOut.current === poppedOut) return;
    const first = shownPoppedOut.current === null;
    shownPoppedOut.current = poppedOut;
    if (first && poppedOut) return;
    const threadKey = scopedThreadKey(threadRef);
    const panels = useRightPanelStore.getState();
    const panelOpen = selectThreadRightPanelState(panels.byThreadKey, threadRef).isOpen;
    const marked = creatorPanelMarks.has(threadKey);
    const step = poppedOut
      ? creatorPoppedOutStep({ panelOpen, marked })
      : creatorReturnedStep({
          panelOpen,
          marked,
          otherPoppedOut: Object.entries(readThreadPreviewState(threadRef).desktopByTabId).some(
            ([tabId, desktop]) => tabId !== serverTabId && desktop.poppedOut,
          ),
        });
    if (step === "close") {
      creatorPanelMarks.set(threadKey);
      panels.close(threadRef);
    } else if (step === "reopen") {
      creatorPanelMarks.clear(threadKey);
      panels.openBrowser(threadRef, serverTabId);
    } else if (step === "forget") {
      creatorPanelMarks.clear(threadKey);
    }
  }, [desktopKnown, poppedOut, serverTabId, threadRef]);
  return null;
}
