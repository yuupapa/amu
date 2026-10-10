/**
 * The renderer's half of an Amu Creator tab: it relays what the desktop main
 * reports (activation, revocation, guest messages, captures) to the server, and
 * pushes the server's state back to the guest overlay. It builds no message and
 * sends nothing to a thread; sending happens on the server after the confirm
 * sheet.
 *
 * Pure apart from the injected ports, so the ordering rules are unit tested:
 * - main events older than the newest epoch seen are dropped;
 * - every server call carries `{ bindingId, epoch }` with that newest epoch;
 * - guest messages are handled one at a time, in arrival order;
 * - a repeated draft `requestId` never creates a second comment;
 * - a draft shot waits (at most 10, for 60 s) for its draft; a place shot is
 *   paired with its own place by `requestId` and attached only after that
 *   `setPlace` succeeded, at the revision it returned (dropped if it was refused);
 * - comment text is passed through exactly as the guest sent it.
 */
import {
  CreatorCommentId,
  CreatorPlace,
  CreatorProposalId,
  NonNegativeInt,
  PositiveInt,
  type CreatorAttachShotInput,
  type CreatorBindingId,
  type CreatorCancelProposalInput,
  type CreatorComment,
  type CreatorConfirmByUserInput,
  type CreatorDeleteCommentInput,
  type CreatorProposal,
  type CreatorProposeInput,
  type CreatorSaveDraftInput,
  type CreatorSetEpochInput,
  type CreatorSetPlaceInput,
  type CreatorSnapshot,
  type CreatorUpdateCommentInput,
  type DesktopPreviewCreatorEvent,
  type DesktopPreviewCreatorRegisterResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { creatorErrorMessage } from "./creatorText";

/**
 * The project version comments are stamped with. The design's per-file version
 * mark is not built in stage 1, so every comment shares one value and none is
 * shown as 「古い版」.
 */
export const CREATOR_PROJECT_REVISION = "current";

const SHOT_BUFFER_MAX = 10;
const SHOT_BUFFER_TTL_MS = 60_000;
/** Draft request ids remembered per binding (newest kept). */
const DRAFT_KEYS_MAX = 200;
/** Place request ids remembered while their shot is awaited, or after a refusal. */
const PLACE_REQUESTS_MAX = 20;

export type CreatorCallResult<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: unknown };

/** The server RPCs the bridge drives (each resolves, never rejects). */
export interface CreatorBridgeRpc {
  readonly setEpoch: (input: CreatorSetEpochInput) => Promise<CreatorCallResult<void>>;
  readonly saveDraft: (input: CreatorSaveDraftInput) => Promise<CreatorCallResult<CreatorComment>>;
  readonly updateComment: (
    input: CreatorUpdateCommentInput,
  ) => Promise<CreatorCallResult<CreatorComment>>;
  readonly setPlace: (input: CreatorSetPlaceInput) => Promise<CreatorCallResult<CreatorComment>>;
  readonly attachShot: (
    input: CreatorAttachShotInput,
  ) => Promise<CreatorCallResult<CreatorComment>>;
  readonly deleteComment: (input: CreatorDeleteCommentInput) => Promise<CreatorCallResult<void>>;
  readonly propose: (input: CreatorProposeInput) => Promise<CreatorCallResult<CreatorProposal>>;
  readonly cancelProposal: (input: CreatorCancelProposalInput) => Promise<CreatorCallResult<void>>;
  readonly confirmByUser: (
    input: CreatorConfirmByUserInput,
  ) => Promise<CreatorCallResult<CreatorComment>>;
}

/** The desktop main calls the bridge makes (a subset of `DesktopPreviewBridge`). */
export interface CreatorBridgeMain {
  readonly registerCreatorSession: (
    tabId: string,
    bindingId: CreatorBindingId,
  ) => Promise<DesktopPreviewCreatorRegisterResult>;
  readonly pushCreatorState: (tabId: string, state: unknown) => Promise<boolean>;
}

export interface CreatorBridgeView {
  /** The newest epoch the server accepted for this binding; subscribe with it. */
  readonly epoch: number | null;
  /** The live document generation, or null while revoked. */
  readonly generation: number | null;
  /** The proposal whose confirm sheet is open. */
  readonly sheetProposalId: CreatorProposalId | null;
  /** That proposal as `propose` returned it, or as the snapshot listed it on reopening. */
  readonly sheetProposal: CreatorProposal | null;
  /** The newest server snapshot (kept while a subscription restarts). */
  readonly snapshot: CreatorSnapshot | null;
}

export interface CreatorBridgeOptions {
  readonly tabId: string;
  readonly bindingId: CreatorBindingId;
  readonly rpc: CreatorBridgeRpc;
  readonly main: CreatorBridgeMain;
  readonly now: () => number;
  readonly onChange: (view: CreatorBridgeView) => void;
  /**
   * `requestId -> commentId` of this binding's drafts. Pass the same map to a
   * bridge recreated for the binding, so a repeated draft still finds its comment.
   */
  readonly draftKeys?: Map<string, CreatorCommentId>;
  /** Whether the preview tab still exists (a destroyed guest is then recreated). */
  readonly tabExists: () => boolean;
}

const RequestId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
const TimeSec = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

const decoders = {
  draft: Schema.decodeUnknownOption(
    Schema.Struct({
      requestId: RequestId,
      timeSec: TimeSec,
      comment: Schema.String,
      place: Schema.NullOr(CreatorPlace),
    }),
  ),
  update: Schema.decodeUnknownOption(
    Schema.Struct({
      commentId: CreatorCommentId,
      expectedRevision: PositiveInt,
      comment: Schema.String,
    }),
  ),
  place: Schema.decodeUnknownOption(
    Schema.Struct({
      requestId: RequestId,
      commentId: CreatorCommentId,
      expectedRevision: PositiveInt,
      place: Schema.NullOr(CreatorPlace),
    }),
  ),
  comment: Schema.decodeUnknownOption(Schema.Struct({ commentId: CreatorCommentId })),
  propose: Schema.decodeUnknownOption(
    Schema.Struct({ commentIds: Schema.Array(CreatorCommentId) }),
  ),
  proposal: Schema.decodeUnknownOption(Schema.Struct({ proposalId: CreatorProposalId })),
  commentId: Schema.decodeUnknownOption(CreatorCommentId),
  epoch: Schema.decodeUnknownOption(NonNegativeInt),
};

interface BufferedShot {
  readonly key: string;
  readonly commentId: CreatorCommentId | null;
  readonly png: Uint8Array;
  readonly at: number;
}

interface SharedDraftSaves {
  readonly documents: Map<
    CreatorBindingId,
    { readonly epoch: number; readonly generation: number | null }
  >;
  readonly pending: Map<string, Promise<CreatorCallResult<CreatorComment>>>;
}

/** The host preserves the keys map across bridge remounts; pending saves follow it. */
const draftSavesByKeys = new WeakMap<Map<string, CreatorCommentId>, SharedDraftSaves>();

/** Revoke reasons after which the renderer registers the tab again. */
const RECOVERABLE_REVOCATIONS = new Set(["navigation", "guest-swapped"]);

export function createCreatorBridge(options: CreatorBridgeOptions) {
  const { tabId, bindingId, rpc, main, now } = options;

  let disposed = false;
  /** Newest epoch main reported (activation or revocation). */
  let latestEpoch = -1;
  let serverEpoch: number | null = null;
  let generation: number | null = null;
  let sheetProposal: CreatorProposal | null = null;
  /** Main stopped the session for good (closed tab, setting off, replaced). */
  let stopped = false;
  let registering = false;

  const draftKeys = options.draftKeys ?? new Map<string, CreatorCommentId>();
  let sharedDrafts = draftSavesByKeys.get(draftKeys);
  if (!sharedDrafts) {
    sharedDrafts = { documents: new Map(), pending: new Map() };
    draftSavesByKeys.set(draftKeys, sharedDrafts);
  }
  const draftSaves = sharedDrafts;
  const noteDraftDocument = (epoch: number, documentGeneration: number | null) => {
    const known = draftSaves.documents.get(bindingId);
    if (known && epoch < known.epoch) return;
    if (known && known.generation !== documentGeneration) draftKeys.clear();
    draftSaves.documents.set(bindingId, { epoch, generation: documentGeneration });
  };
  /** Newest revision seen per comment, from RPC results and snapshots. */
  const revisions = new Map<CreatorCommentId, number>();
  /** Place requests whose `setPlace` succeeded and whose shot has not arrived yet. */
  const placeReady = new Map<string, CreatorCommentId>();
  /** Place requests the server refused; their shot is dropped. */
  const placeRefused = new Set<string>();
  let shots: BufferedShot[] = [];

  let lastSnapshot: CreatorSnapshot | null = null;
  let lastPushedKey: string | null = null;
  let pendingNotice: string | null = null;
  let forcePush = false;

  let queue: Promise<void> = Promise.resolve();
  let pushQueue: Promise<void> = Promise.resolve();

  const view = (): CreatorBridgeView => ({
    epoch: serverEpoch,
    generation: serverEpoch === null ? null : generation,
    sheetProposalId: sheetProposal?.id ?? null,
    sheetProposal,
    snapshot: lastSnapshot,
  });
  const changed = () => {
    if (!disposed) options.onChange(view());
  };

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const next = queue.then(() => (disposed ? undefined : task()));
    queue = next.catch(() => undefined);
    return queue;
  };

  const binding = () => ({ bindingId, epoch: latestEpoch });

  const noteRevision = (comment: CreatorComment) => {
    const known = revisions.get(comment.id) ?? 0;
    if (comment.revision > known) revisions.set(comment.id, comment.revision);
  };

  const refuse = async (error: unknown) => {
    pendingNotice = creatorErrorMessage(error).slice(0, 200);
    await push();
  };

  /** Runs one RPC; a refusal becomes the guest's notice. */
  const call = async <A>(result: Promise<CreatorCallResult<A>>): Promise<A | undefined> => {
    const settled = await result;
    if (settled.ok) return settled.value;
    await refuse(settled.error);
    return undefined;
  };

  const pruneShots = () => {
    const cutoff = now() - SHOT_BUFFER_TTL_MS;
    shots = shots.filter((entry) => entry.at > cutoff);
  };
  const bufferShot = (key: string, png: Uint8Array, commentId: CreatorCommentId | null = null) => {
    pruneShots();
    shots = [
      ...shots.filter((entry) => entry.key !== key),
      { key, commentId, png, at: now() },
    ].slice(-SHOT_BUFFER_MAX);
  };
  const takeShot = (key: string): BufferedShot | null => {
    pruneShots();
    const found = shots.find((entry) => entry.key === key);
    if (!found) return null;
    shots = shots.filter((entry) => entry !== found);
    return found;
  };
  /** Insertion-ordered maps and sets keep their newest `max` entries. */
  const trim = (collection: Map<string, unknown> | Set<string>, max: number) => {
    for (const key of collection.keys()) {
      if (collection.size <= max) return;
      collection.delete(key);
    }
  };

  const attachShot = async (commentId: CreatorCommentId, png: Uint8Array) => {
    const expectedRevision = revisions.get(commentId);
    if (expectedRevision === undefined) return;
    const updated = await call(rpc.attachShot({ ...binding(), commentId, expectedRevision, png }));
    if (updated) noteRevision(updated);
  };

  // ---- main events ----

  const applyActivation = async (epoch: number, nextGeneration: number) => {
    if (epoch <= latestEpoch) return;
    latestEpoch = epoch;
    noteDraftDocument(epoch, nextGeneration);
    generation = nextGeneration;
    const settled = await rpc.setEpoch({ bindingId, epoch, generation: nextGeneration });
    // Expose the epoch only once the server knows it, so a subscription is never refused.
    if (settled.ok && latestEpoch === epoch) serverEpoch = epoch;
    changed();
  };

  const applyRevocation = async (epoch: number, reason: string) => {
    latestEpoch = epoch;
    const recoverable =
      RECOVERABLE_REVOCATIONS.has(reason) || (reason === "destroyed" && options.tabExists());
    // A recoverable revoke may finish a save before the next activation. Keep
    // that document's keys until main supplies its replacement generation.
    noteDraftDocument(
      epoch,
      recoverable ? (draftSaves.documents.get(bindingId)?.generation ?? null) : null,
    );
    generation = null;
    sheetProposal = null;
    changed();
    await rpc.setEpoch({ bindingId, epoch, generation: null });
    // A destroyed guest of a tab that still exists comes back with the webview.
    if (recoverable) {
      await register();
    } else {
      stopped = true;
      draftKeys.clear();
    }
  };

  const register = async () => {
    if (disposed || stopped || registering) return;
    registering = true;
    try {
      const result = await main.registerCreatorSession(tabId, bindingId);
      if (result.ok) await applyActivation(result.epoch, result.generation);
    } finally {
      registering = false;
    }
  };

  const onDraft = async (payload: unknown) => {
    const draft = Option.getOrNull(decoders.draft(payload));
    if (draft === null) return;
    const existing = draftKeys.get(draft.requestId);
    if (existing !== undefined) {
      // The user's 「もう一度保存」: the comment exists, so only tell the guest again.
      forcePush = true;
      await push();
      return;
    }
    const ref = binding();
    const draftGeneration = generation;
    // Main issues a new epoch for a same-document remount, but preserves generation.
    const key = `${bindingId}:${draftGeneration}:${draft.requestId}`;
    let pending = draftSaves.pending.get(key);
    if (!pending) {
      pending = rpc
        .saveDraft({
          ...ref,
          timeSec: draft.timeSec,
          comment: draft.comment as CreatorSaveDraftInput["comment"],
          place: draft.place,
          projectRevision: CREATOR_PROJECT_REVISION,
        })
        .then((settled) => {
          // A disposed bridge can complete a shared save, but a newer document owns the keys.
          if (settled.ok && draftSaves.documents.get(bindingId)?.generation === draftGeneration) {
            draftKeys.set(draft.requestId, settled.value.id);
            trim(draftKeys, DRAFT_KEYS_MAX);
          }
          return settled;
        })
        .finally(() => {
          if (draftSaves.pending.get(key) === pending) draftSaves.pending.delete(key);
        });
      draftSaves.pending.set(key, pending);
    }
    const settled = await pending;
    if (
      disposed ||
      stopped ||
      latestEpoch !== ref.epoch ||
      generation !== draftGeneration ||
      draftSaves.documents.get(bindingId)?.epoch !== ref.epoch
    )
      return;
    if (!settled.ok) {
      await refuse(settled.error);
      return;
    }
    const created = settled.value;
    noteRevision(created);
    const buffered = takeShot(`draft:${draft.requestId}`);
    if (buffered) await attachShot(created.id, buffered.png);
    await push();
  };

  const onShot = async (event: Extract<DesktopPreviewCreatorEvent, { kind: "shot" }>) => {
    if (!(event.png instanceof Uint8Array) || typeof event.requestId !== "string") return;
    if (event.purpose === "draft") {
      const commentId = draftKeys.get(event.requestId);
      if (commentId === undefined) bufferShot(`draft:${event.requestId}`, event.png);
      else await attachShot(commentId, event.png);
      return;
    }
    if (event.purpose !== "place") return;
    const commentId = Option.getOrNull(decoders.commentId(event.commentId));
    if (commentId === null) return;
    const requestId = event.requestId;
    if (placeRefused.delete(requestId)) return;
    const placed = placeReady.get(requestId);
    if (placed === undefined) {
      // The capture overtook its place: wait for that place's answer.
      bufferShot(`place:${requestId}`, event.png, commentId);
      return;
    }
    placeReady.delete(requestId);
    if (placed === commentId) await attachShot(commentId, event.png);
  };

  const onPlace = async (payload: unknown) => {
    const input = Option.getOrNull(decoders.place(payload));
    if (input === null) return;
    const { requestId, ...place } = input;
    const updated = await call(rpc.setPlace({ ...binding(), ...place }));
    const buffered = takeShot(`place:${requestId}`);
    if (!updated) {
      if (buffered === null) {
        placeRefused.add(requestId);
        trim(placeRefused, PLACE_REQUESTS_MAX);
      }
      return;
    }
    noteRevision(updated);
    if (buffered === null) {
      placeReady.set(requestId, place.commentId);
      trim(placeReady, PLACE_REQUESTS_MAX);
    } else if (buffered.commentId === place.commentId) {
      await attachShot(place.commentId, buffered.png);
    }
  };

  const onGuest = async (kind: string, payload: unknown) => {
    switch (kind) {
      case "draft":
        return onDraft(payload);
      case "place":
        return onPlace(payload);
      case "update": {
        const input = Option.getOrNull(decoders.update(payload));
        if (input === null) return;
        const updated = await call(
          rpc.updateComment({
            ...binding(),
            ...input,
            comment: input.comment as CreatorUpdateCommentInput["comment"],
          }),
        );
        if (updated) noteRevision(updated);
        return;
      }
      case "delete": {
        const input = Option.getOrNull(decoders.comment(payload));
        if (input !== null) await call(rpc.deleteComment({ ...binding(), ...input }));
        return;
      }
      case "confirm-by-user": {
        const input = Option.getOrNull(decoders.comment(payload));
        if (input === null) return;
        const updated = await call(rpc.confirmByUser({ ...binding(), ...input }));
        if (updated) noteRevision(updated);
        return;
      }
      case "cancel": {
        const input = Option.getOrNull(decoders.proposal(payload));
        if (input !== null) await call(rpc.cancelProposal({ ...binding(), ...input }));
        return;
      }
      case "propose": {
        const input = Option.getOrNull(decoders.propose(payload));
        if (input === null || input.commentIds.length === 0) return;
        const proposal = await call(
          rpc.propose({
            ...binding(),
            commentIds: input.commentIds as unknown as CreatorProposeInput["commentIds"],
          }),
        );
        if (!proposal) return;
        sheetProposal = proposal;
        changed();
        return;
      }
    }
  };

  const handleMainEvent = (event: DesktopPreviewCreatorEvent): Promise<void> => {
    if (disposed || event.tabId !== tabId || event.bindingId !== bindingId) {
      return Promise.resolve();
    }
    return enqueue(async () => {
      const epoch = Option.getOrNull(decoders.epoch(event.epoch));
      if (epoch === null || epoch < latestEpoch) return;
      switch (event.kind) {
        case "activated":
          return applyActivation(epoch, event.generation);
        case "revoked":
          if (epoch === latestEpoch && generation === null) return;
          return applyRevocation(epoch, event.reason);
        case "shot":
          if (generation === null || epoch !== latestEpoch) return;
          return onShot(event);
        default:
          if (generation === null || epoch !== latestEpoch) return;
          return onGuest(event.kind, event.payload);
      }
    });
  };

  // ---- server state -> guest ----

  const push = (): Promise<void> => {
    const run = async () => {
      if (disposed || lastSnapshot === null || generation === null) return;
      const keys = Object.fromEntries(draftKeys);
      const key = JSON.stringify([generation, lastSnapshot.revision, keys]);
      if (key === lastPushedKey && pendingNotice === null && !forcePush) return;
      const notice = pendingNotice;
      const accepted = await main.pushCreatorState(tabId, {
        ...lastSnapshot,
        draftKeys: keys,
        projectRevision: CREATOR_PROJECT_REVISION,
        notice,
      });
      if (!accepted) return;
      lastPushedKey = key;
      forcePush = false;
      if (pendingNotice === notice) pendingNotice = null;
    };
    const next = pushQueue.then(run);
    pushQueue = next.catch(() => undefined);
    return pushQueue;
  };

  const handleSnapshot = (snapshot: CreatorSnapshot): Promise<void> => {
    if (disposed) return Promise.resolve();
    const fresh = snapshot !== lastSnapshot;
    lastSnapshot = snapshot;
    for (const comment of snapshot.comments) noteRevision(comment);
    if (fresh) changed();
    return push();
  };

  return {
    view,
    /**
     * Registers the tab with main unless a session is live; called on mount and
     * whenever the tab's page may have changed (the guest may not exist yet).
     */
    register: (): Promise<void> =>
      enqueue(() => (generation === null ? register() : Promise.resolve())),
    handleMainEvent,
    handleSnapshot,
    /** Opens the confirm sheet for a live proposal (e.g. one that needs the user again). */
    openSheet: (proposal: CreatorProposal) => {
      sheetProposal = proposal;
      changed();
    },
    closeSheet: () => {
      if (sheetProposal === null) return;
      sheetProposal = null;
      changed();
    },
    dispose: () => {
      disposed = true;
    },
  };
}

export type CreatorBridge = ReturnType<typeof createCreatorBridge>;

/**
 * Calls `revokeAll` once each time the Creator setting is seen turning (or
 * starting) off. `undefined` means the setting is not known yet.
 */
export function createCreatorSettingGate(revokeAll: () => void) {
  let last: boolean | undefined;
  return (enabled: boolean | undefined) => {
    if (enabled === undefined) return;
    if (!enabled && last !== false) revokeAll();
    last = enabled;
  };
}
