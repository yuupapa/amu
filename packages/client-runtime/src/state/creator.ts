import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Amu Creator RPCs. Every call but `openByUser` carries `{ bindingId, epoch }`;
 * the server refuses an epoch it does not know as the binding's newest. The
 * desktop app's own session is the only caller the server accepts in stage 1.
 */
export function createCreatorEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    openByUser: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:creator:open-by-user",
      tag: WS_METHODS.creatorOpenByUser,
    }),
    setEpoch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:creator:set-epoch",
      tag: WS_METHODS.creatorSetEpoch,
    }),
    saveDraft: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:creator:save-draft",
      tag: WS_METHODS.creatorSaveDraft,
    }),
    updateComment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:creator:update-comment",
      tag: WS_METHODS.creatorUpdateComment,
    }),
    setPlace: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:creator:set-place",
      tag: WS_METHODS.creatorSetPlace,
    }),
    attachShot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:creator:attach-shot",
      tag: WS_METHODS.creatorAttachShot,
    }),
    deleteComment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:creator:delete-comment",
      tag: WS_METHODS.creatorDeleteComment,
    }),
    propose: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:creator:propose",
      tag: WS_METHODS.creatorPropose,
    }),
    cancelProposal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:creator:cancel-proposal",
      tag: WS_METHODS.creatorCancelProposal,
    }),
    confirmSend: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:creator:confirm-send",
      tag: WS_METHODS.creatorConfirmSend,
    }),
    haltSend: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:creator:halt-send",
      tag: WS_METHODS.creatorHaltSend,
    }),
    acknowledgeConflict: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:creator:acknowledge-conflict",
      tag: WS_METHODS.creatorAcknowledgeConflict,
    }),
    confirmByUser: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:creator:confirm-by-user",
      tag: WS_METHODS.creatorConfirmByUser,
    }),
    readShot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:creator:read-shot",
      tag: WS_METHODS.creatorReadShot,
    }),
    /** Full project snapshot on every change. Keyed by `{ bindingId, epoch }`, so a new epoch resubscribes. */
    subscribe: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:creator:subscribe",
      tag: WS_METHODS.creatorSubscribe,
      idleTtlMs: 0,
    }),
  };
}
