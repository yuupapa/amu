/**
 * Keeps every Amu Creator tab of the active thread connected (desktop main <->
 * server) and draws its confirm sheet. Lives in the chat view rather than the
 * preview panel, so switching the right panel to another tab does not drop the
 * guest's drafts or captures on the floor.
 */
import type { CreatorBindingId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { previewBridge } from "~/components/preview/previewBridge";
import { useThreadPreviewState } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";

import { CreatorConfirmSheet } from "./CreatorConfirmSheet";
import { setCreatorAttention } from "./creatorAttention";
import { creatorAttentionProposal } from "./creatorSheet";
import {
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
}) {
  const { threadRef, serverTabId, runtimeTabId, bindingId, poppedOut } = props;
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

  const live = session.view.generation !== null;
  useEffect(() => {
    if (!autoPopout || !live || !takeCreatorAutoPopout(runtimeTabId)) return;
    void runCreatorWindowAction("pop-out", runtimeTabId).then((opened) => {
      if (!opened) useRightPanelStore.getState().openBrowser(threadRef, serverTabId);
    });
  }, [autoPopout, live, runtimeTabId, serverTabId, threadRef]);

  // Acts on transitions only: mounting on an already popped-out tab changes nothing.
  const shownPoppedOut = useRef(poppedOut);
  useEffect(() => {
    if (shownPoppedOut.current === poppedOut) return;
    shownPoppedOut.current = poppedOut;
    const panels = useRightPanelStore.getState();
    if (poppedOut) panels.close(threadRef);
    else panels.openBrowser(threadRef, serverTabId);
  }, [poppedOut, serverTabId, threadRef]);
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
