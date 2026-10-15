/**
 * Keeps every Amu Creator tab of the active thread connected (desktop main <->
 * server) and draws its confirm sheet. Lives in the chat view rather than the
 * preview panel, so switching the right panel to another tab does not drop the
 * guest's drafts or captures on the floor.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { CreatorBindingId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { previewBridge } from "~/components/preview/previewBridge";
import { readThreadPreviewState, useThreadPreviewState } from "~/previewStateStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";

import { CreatorConfirmSheet } from "./CreatorConfirmSheet";
import { setCreatorAttention } from "./creatorAttention";
import { creatorAttentionProposal } from "./creatorSheet";
import {
  creatorPanelMarks,
  creatorPoppedOutStep,
  creatorReturnedStep,
} from "./creatorPanelAutoClose";
import {
  clearCreatorAutoPopout,
  runCreatorWindowAction,
  takeCreatorAutoPopout,
  useCreatorAutoPopoutRequested,
} from "./creatorWindow";
import { useCreatorEnabled, useCreatorSession, useCreatorSettingGate } from "./useCreatorSession";

function CreatorSessionRunner(props: {
  readonly threadRef: ScopedThreadRef;
  readonly serverTabId: string;
  readonly runtimeTabId: string;
  readonly bindingId: CreatorBindingId;
}) {
  const { threadRef, serverTabId, runtimeTabId, bindingId } = props;
  const session = useCreatorSession({
    threadRef,
    serverTabId,
    runtimeTabId,
    bindingId,
    enabled: true,
  });
  const proposal = session.view.sheetProposal;
  const bridge = session.bridge;

  // A started send whose sheet is closed gets a banner in the tab's panel that reopens it.
  const [attentionHolder] = useState(() => Symbol("creator-attention"));
  const attention = session.isOwner
    ? creatorAttentionProposal(session.view.snapshot, session.view.sheetProposalId)
    : null;
  useEffect(() => {
    if (attention === null || bridge === null) {
      setCreatorAttention(runtimeTabId, attentionHolder, null);
      return;
    }
    setCreatorAttention(runtimeTabId, attentionHolder, {
      proposal: attention,
      open: () => bridge.openSheet(attention),
    });
    return () => setCreatorAttention(runtimeTabId, attentionHolder, null);
  }, [attention, attentionHolder, bridge, runtimeTabId]);

  const destination = useThreadShell(
    proposal
      ? { environmentId: threadRef.environmentId, threadId: proposal.destination.threadId }
      : null,
  );
  if (!session.isOwner || proposal === null || bridge === null) return null;
  return (
    <CreatorConfirmSheet
      key={proposal.id}
      environmentId={threadRef.environmentId}
      runtimeTabId={runtimeTabId}
      bindingId={bindingId}
      view={session.view}
      snapshot={session.view.snapshot}
      proposal={proposal}
      threadTitle={destination?.title ?? null}
      onClose={bridge.closeSheet}
    />
  );
}

/**
 * Watches one Creator tab from the app-wide browser host, which stays mounted
 * whichever thread is shown and whether or not the right panel is open:
 *
 * - While the tab is popped out it holds the tab's bridge (passively: the chat
 *   view's runner keeps the confirm sheet), so comments made in the window
 *   still reach the server after a thread switch.
 * - Popping out closes the thread's right panel, leaving the chat the whole
 *   width; coming back by any path (the button, the window's ×, a crash, a
 *   failed load) reopens it on this tab. A panel the user reopens meanwhile is
 *   left alone.
 * - A tab an agent just opened moves into its window once its session is
 *   live; if that fails it stays in the panel, after a toast.
 */
export function CreatorTabWatcher(props: {
  readonly threadRef: ScopedThreadRef;
  readonly serverTabId: string;
  readonly runtimeTabId: string;
  readonly bindingId: CreatorBindingId;
  readonly poppedOut: boolean;
  /** Whether the desktop has reported this tab yet; until then `poppedOut` is only a default. */
  readonly desktopKnown: boolean;
}) {
  const { threadRef, serverTabId, runtimeTabId, bindingId, poppedOut, desktopKnown } = props;
  const enabled = useCreatorEnabled(threadRef.environmentId) === true && previewBridge !== null;
  const autoPopout = useCreatorAutoPopoutRequested(runtimeTabId);
  const session = useCreatorSession({
    threadRef,
    serverTabId,
    runtimeTabId,
    bindingId,
    enabled: enabled && (poppedOut || autoPopout),
    passive: true,
  });

  // A closed tab's request goes with it.
  useEffect(() => () => clearCreatorAutoPopout(runtimeTabId), [runtimeTabId]);
  const live = session.view.generation !== null;
  useEffect(() => {
    if (!autoPopout || !live || !takeCreatorAutoPopout(runtimeTabId)) return;
    void runCreatorWindowAction("pop-out", runtimeTabId).then((opened) => {
      if (!opened) useRightPanelStore.getState().openBrowser(threadRef, serverTabId);
    });
  }, [autoPopout, live, runtimeTabId, serverTabId, threadRef]);

  // Acts on transitions. The first known state only recovers a panel a pop-out
  // closed before a crash or restart; mounting on a popped-out tab changes nothing.
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

export function CreatorSessionHost(props: { readonly threadRef: ScopedThreadRef }) {
  useCreatorSettingGate();
  const enabled = useCreatorEnabled(props.threadRef.environmentId) === true;
  const previewState = useThreadPreviewState(props.threadRef);
  if (!enabled || !previewBridge) return null;
  return Object.values(previewState.sessions).map((session) =>
    session.creator ? (
      <CreatorSessionRunner
        key={`${session.tabId}:${session.creator.bindingId}`}
        threadRef={props.threadRef}
        serverTabId={session.tabId}
        runtimeTabId={previewRuntimeTabId(props.threadRef, previewState.serverEpoch, session.tabId)}
        bindingId={session.creator.bindingId}
      />
    ) : null,
  );
}
