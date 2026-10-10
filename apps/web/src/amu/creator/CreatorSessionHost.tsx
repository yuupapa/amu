/**
 * Keeps every Amu Creator tab of the active thread connected (desktop main <->
 * server) and draws its confirm sheet. Lives in the chat view rather than the
 * preview panel, so switching the right panel to another tab does not drop the
 * guest's drafts or captures on the floor.
 */
import type { CreatorBindingId, ScopedThreadRef } from "@t3tools/contracts";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { previewBridge } from "~/components/preview/previewBridge";
import { useThreadPreviewState } from "~/previewStateStore";
import { useThreadShell } from "~/state/entities";

import { CreatorConfirmSheet } from "./CreatorConfirmSheet";
import { useCreatorEnabled, useCreatorSession, useCreatorSettingGate } from "./useCreatorSession";

function CreatorSessionRunner(props: {
  readonly threadRef: ScopedThreadRef;
  readonly runtimeTabId: string;
  readonly bindingId: CreatorBindingId;
}) {
  const { threadRef, runtimeTabId, bindingId } = props;
  const session = useCreatorSession({
    environmentId: threadRef.environmentId,
    runtimeTabId,
    bindingId,
    enabled: true,
  });
  const proposal = session.view.sheetProposal;
  const destination = useThreadShell(
    proposal
      ? { environmentId: threadRef.environmentId, threadId: proposal.destination.threadId }
      : null,
  );
  const bridge = session.bridge;
  if (!session.isOwner || proposal === null || bridge === null) return null;
  return (
    <CreatorConfirmSheet
      key={proposal.id}
      environmentId={threadRef.environmentId}
      runtimeTabId={runtimeTabId}
      bindingId={bindingId}
      view={session.view}
      snapshot={session.snapshot}
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
        runtimeTabId={previewRuntimeTabId(props.threadRef, previewState.serverEpoch, session.tabId)}
        bindingId={session.creator.bindingId}
      />
    ) : null,
  );
}
