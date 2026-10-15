/**
 * React glue for one Amu Creator tab: creates the bridge, feeds it the desktop
 * main's events and the server's snapshots, and exposes its view. The bridge
 * outlives a panel switch (it is held by `CreatorSessionHost` in the chat view,
 * not by the preview panel) and is shared when two panes show the same thread,
 * so one tab never has two bridges turning one draft into two comments.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  CreatorBindingId,
  CreatorCommentId,
  CreatorSnapshot,
  EnvironmentId,
  ScopedThreadRef,
  ServerSettings,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useEffect, useId, useMemo, useState, useSyncExternalStore } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { readThreadPreviewState } from "~/previewStateStore";
import { creatorEnvironment } from "~/state/creator";
import { useServerConfigs } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  createCreatorBridge,
  createCreatorSettingGate,
  type CreatorBridge,
  type CreatorBridgeRpc,
  type CreatorBridgeView,
  type CreatorCallResult,
} from "./creatorBridge";

export const toCreatorCallResult = <A, E>(result: AtomCommandResult<A, E>): CreatorCallResult<A> =>
  AsyncResult.isSuccess(result)
    ? { ok: true, value: result.value }
    : { ok: false, error: squashAtomCommandFailure(result) };

/** The Creator RPCs bound to one environment, as the bridge calls them. */
export function useCreatorRpc(environmentId: EnvironmentId): CreatorBridgeRpc {
  const quiet = { reportFailure: false } as const;
  const setEpoch = useAtomCommand(creatorEnvironment.setEpoch, quiet);
  const saveDraft = useAtomCommand(creatorEnvironment.saveDraft, quiet);
  const updateComment = useAtomCommand(creatorEnvironment.updateComment, quiet);
  const setPlace = useAtomCommand(creatorEnvironment.setPlace, quiet);
  const attachShot = useAtomCommand(creatorEnvironment.attachShot, quiet);
  const deleteComment = useAtomCommand(creatorEnvironment.deleteComment, quiet);
  const propose = useAtomCommand(creatorEnvironment.propose, quiet);
  const cancelProposal = useAtomCommand(creatorEnvironment.cancelProposal, quiet);
  const confirmByUser = useAtomCommand(creatorEnvironment.confirmByUser, quiet);
  return useMemo(
    () => ({
      setEpoch: async (input) => toCreatorCallResult(await setEpoch({ environmentId, input })),
      saveDraft: async (input) => toCreatorCallResult(await saveDraft({ environmentId, input })),
      updateComment: async (input) =>
        toCreatorCallResult(await updateComment({ environmentId, input })),
      setPlace: async (input) => toCreatorCallResult(await setPlace({ environmentId, input })),
      attachShot: async (input) => toCreatorCallResult(await attachShot({ environmentId, input })),
      deleteComment: async (input) =>
        toCreatorCallResult(await deleteComment({ environmentId, input })),
      propose: async (input) => toCreatorCallResult(await propose({ environmentId, input })),
      cancelProposal: async (input) =>
        toCreatorCallResult(await cancelProposal({ environmentId, input })),
      confirmByUser: async (input) =>
        toCreatorCallResult(await confirmByUser({ environmentId, input })),
    }),
    [
      attachShot,
      cancelProposal,
      confirmByUser,
      deleteComment,
      environmentId,
      propose,
      saveDraft,
      setEpoch,
      setPlace,
      updateComment,
    ],
  );
}

/** Whether Amu Creator is on for this environment (`undefined` while unknown). */
export function useCreatorEnabled(environmentId: EnvironmentId | null): boolean | undefined {
  const configs = useServerConfigs();
  if (environmentId === null) return undefined;
  const settings: ServerSettings | undefined = configs.get(environmentId)?.settings;
  return settings?.amuCreatorEnabled;
}

/**
 * Revokes every Creator session in the desktop main once whenever the local
 * server's setting is seen off. Mounted once per chat view.
 */
export function useCreatorSettingGate(): void {
  const enabled = useCreatorEnabled(usePrimaryEnvironmentId());
  const observe = useMemo(
    () =>
      createCreatorSettingGate(() => {
        void previewBridge?.revokeAllCreatorSessions().catch(() => undefined);
      }),
    [],
  );
  useEffect(() => {
    if (previewBridge) observe(enabled);
  }, [enabled, observe]);
}

interface SharedBridge {
  readonly bridge: CreatorBridge;
  readonly holders: Set<string>;
  /** Holders that only keep the bridge alive and never draw its sheet. */
  readonly passiveHolders: Set<string>;
  readonly listeners: Set<(view: CreatorBridgeView) => void>;
  /** Told when a holder joins or leaves, so the sheet owner moves with it. */
  readonly holderListeners: Set<() => void>;
  readonly release: () => void;
}

const sharedBridges = new Map<string, SharedBridge>();
/**
 * Draft keys per binding, kept across bridge recreation (thread switch,
 * remount). The bridge empties a binding's map when main ends its session.
 */
const draftKeysByBinding = new Map<CreatorBindingId, Map<string, CreatorCommentId>>();

const firstHolder = (shared: SharedBridge) => {
  for (const holder of shared.holders) {
    if (!shared.passiveHolders.has(holder)) return holder;
  }
  return undefined;
};
const notifyHolders = (shared: SharedBridge) => {
  for (const listener of shared.holderListeners) listener();
};

function acquireBridge(
  key: string,
  holder: string,
  passive: boolean,
  input: {
    tabId: string;
    bindingId: CreatorBindingId;
    rpc: CreatorBridgeRpc;
    tabExists: () => boolean;
  },
): SharedBridge {
  const existing = sharedBridges.get(key);
  if (existing) {
    existing.holders.add(holder);
    if (passive) existing.passiveHolders.add(holder);
    notifyHolders(existing);
    return existing;
  }
  let draftKeys = draftKeysByBinding.get(input.bindingId);
  if (draftKeys === undefined) {
    draftKeys = new Map();
    draftKeysByBinding.set(input.bindingId, draftKeys);
  }
  const bridge = previewBridge;
  if (!bridge) throw new Error("Amu Creator needs the desktop app");
  const listeners = new Set<(view: CreatorBridgeView) => void>();
  // Every holder's RPCs go to the same environment (it is part of the key), so
  // the first holder's are as good as any.
  const creator = createCreatorBridge({
    tabId: input.tabId,
    bindingId: input.bindingId,
    rpc: input.rpc,
    main: {
      registerCreatorSession: (tabId, bindingId) =>
        bridge
          .registerCreatorSession(tabId, bindingId)
          .catch((): { ok: false; reason: string } => ({ ok: false, reason: "ipc" })),
      pushCreatorState: (tabId, state) => bridge.pushCreatorState(tabId, state).catch(() => false),
    },
    now: () => Date.now(),
    onChange: (view) => {
      for (const listener of listeners) listener(view);
    },
    draftKeys,
    tabExists: input.tabExists,
  });
  const unsubscribeEvents = bridge.onCreatorEvent((event) => {
    void creator.handleMainEvent(event);
  });
  // The guest may attach or finish loading after the tab appears; try again then.
  const unsubscribeState = bridge.onStateChange((tabId) => {
    if (tabId === input.tabId) void creator.register();
  });
  void creator.register();
  const shared: SharedBridge = {
    bridge: creator,
    holders: new Set([holder]),
    passiveHolders: new Set(passive ? [holder] : []),
    listeners,
    holderListeners: new Set(),
    release: () => {
      unsubscribeEvents();
      unsubscribeState();
      creator.dispose();
    },
  };
  sharedBridges.set(key, shared);
  return shared;
}

function releaseBridge(key: string, holder: string): void {
  const shared = sharedBridges.get(key);
  if (!shared) return;
  shared.holders.delete(holder);
  shared.passiveHolders.delete(holder);
  if (shared.holders.size > 0) {
    notifyHolders(shared);
    return;
  }
  sharedBridges.delete(key);
  // The main session is left as it is: a later mount registers again.
  shared.release();
}

const EMPTY_SNAPSHOT_ATOM = Atom.make(AsyncResult.initial<CreatorSnapshot, never>()).pipe(
  Atom.withLabel("creator-subscribe:empty"),
);

const INACTIVE_VIEW: CreatorBridgeView = {
  epoch: null,
  generation: null,
  sheetProposalId: null,
  sheetProposal: null,
  snapshot: null,
};

export interface CreatorSessionState {
  readonly bridge: CreatorBridge | null;
  /** `view.snapshot` is the newest server snapshot, kept while a subscription restarts. */
  readonly view: CreatorBridgeView;
  /** The first holder of a shared bridge draws its confirm sheet. */
  readonly isOwner: boolean;
}

/** One Creator tab's session. Does nothing (and holds no bridge) unless `enabled`. */
export function useCreatorSession(input: {
  readonly threadRef: ScopedThreadRef;
  /** The server's tab id (the preview session), used to tell a closed tab from a reloaded guest. */
  readonly serverTabId: string;
  readonly runtimeTabId: string;
  readonly bindingId: CreatorBindingId;
  readonly enabled: boolean;
  /** Keeps the bridge forwarding without ever owning its confirm sheet. */
  readonly passive?: boolean;
}): CreatorSessionState {
  const { threadRef, serverTabId, runtimeTabId, bindingId, enabled, passive = false } = input;
  const environmentId = threadRef.environmentId;
  const threadId = threadRef.threadId;
  const holder = useId();
  const rpc = useCreatorRpc(environmentId);
  const [shared, setShared] = useState<SharedBridge | null>(null);
  const [view, setView] = useState<CreatorBridgeView>(INACTIVE_VIEW);

  useEffect(() => {
    if (!enabled || !previewBridge) return;
    const key = `${environmentId}\0${runtimeTabId}\0${bindingId}`;
    const acquired = acquireBridge(key, holder, passive, {
      tabId: runtimeTabId,
      bindingId,
      rpc,
      tabExists: () =>
        readThreadPreviewState({ environmentId, threadId }).sessions[serverTabId] !== undefined,
    });
    acquired.listeners.add(setView);
    // oxlint-disable-next-line react/set-state-in-effect -- Publishes the shared bridge this effect just acquired from the registry.
    setShared(acquired);
    setView(acquired.bridge.view());
    return () => {
      acquired.listeners.delete(setView);
      releaseBridge(key, holder);
      setShared(null);
      setView(INACTIVE_VIEW);
    };
  }, [
    bindingId,
    enabled,
    environmentId,
    holder,
    passive,
    rpc,
    runtimeTabId,
    serverTabId,
    threadId,
  ]);

  const subscribeHolders = useCallback(
    (notify: () => void) => {
      if (shared === null) return () => undefined;
      shared.holderListeners.add(notify);
      return () => {
        shared.holderListeners.delete(notify);
      };
    },
    [shared],
  );
  const isOwner = useSyncExternalStore(
    subscribeHolders,
    () => shared !== null && firstHolder(shared) === holder,
    () => false,
  );

  const subscribed = shared !== null && view.epoch !== null && view.generation !== null;
  const result = useAtomValue(
    subscribed
      ? creatorEnvironment.subscribe({
          environmentId,
          input: { bindingId, epoch: view.epoch ?? 0 },
        })
      : EMPTY_SNAPSHOT_ATOM,
  );
  const snapshot = AsyncResult.isSuccess(result) ? result.value : null;
  useEffect(() => {
    if (shared && snapshot) void shared.bridge.handleSnapshot(snapshot);
  }, [shared, snapshot]);

  return { bridge: shared?.bridge ?? null, view, isOwner };
}
