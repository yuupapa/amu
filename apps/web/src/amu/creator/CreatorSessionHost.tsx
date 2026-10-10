/**
 * Keeps every Amu Creator tab of the active thread connected (desktop main <->
 * server) and draws its confirm sheet. Lives in the chat view rather than the
 * preview panel, so switching the right panel to another tab does not drop the
 * guest's drafts or captures on the floor.
 */
import type { CreatorBindingId, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { previewBridge } from "~/components/preview/previewBridge";
import { useThreadPreviewState } from "~/previewStateStore";
import { useThreadShell } from "~/state/entities";

import { CreatorConfirmSheet } from "./CreatorConfirmSheet";
import { setCreatorAttention } from "./creatorAttention";
import { creatorAttentionProposal } from "./creatorSheet";
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
  const attention = session.isOwner
    ? creatorAttentionProposal(session.view.snapshot, session.view.sheetProposalId)
    : null;
  useEffect(() => {
    if (attention === null || bridge === null) {
      setCreatorAttention(runtimeTabId, null);
      return;
    }
    setCreatorAttention(runtimeTabId, {
      proposal: attention,
      open: () => bridge.openSheet(attention),
    });
    return () => setCreatorAttention(runtimeTabId, null);
  }, [attention, bridge, runtimeTabId]);

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
