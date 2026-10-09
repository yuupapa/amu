// @effect-diagnostics nodeBuiltinImport:off - a synchronous SHA-256 for a pure function; Effect's Crypto is effectful.
/**
 * Amu Creator comment state: pure, immutable transitions over `CreatorStoreFile`.
 *
 * Every operation is `(state, input, ctx) => StateResult`. Nothing here does I/O or
 * keeps module state; the clock, id source and rate gate come in through `ctx`.
 * The caller (CreatorService) is the only writer and serializes calls per project.
 *
 * Reservations: a proposal holds its comments in `state.reservations`. Editing or
 * deleting a reserved comment voids the whole proposal, so an approval can never
 * cover content the user did not see. Finished proposals (accepted, rejected,
 * voided, cancelled) are compacted into `state.history` (newest first, trimmed to
 * `CREATOR_LIMITS.maxHistory`), which keeps `comments.json` bounded.
 */
import * as NodeCrypto from "node:crypto";

import {
  CREATOR_LIMITS,
  CreatorPlace,
  type CreatorBindingId,
  type CreatorComment,
  type CreatorCommentId,
  type CreatorCommentStatus,
  type CreatorDestination,
  type CreatorProposal,
  type CreatorProposalHistory,
  type CreatorProposalId,
  type CreatorProposalItem,
  type CreatorProposalOutcome,
  type CreatorSendRecord,
  type CreatorShotRef,
  type CreatorStoreFile,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { RateGate } from "./rateGate.ts";

/** Resends before a send is called `stuck` and the user may stop it. */
export const CREATOR_MAX_SEND_ATTEMPTS = 3;

export interface CreatorStateContext {
  readonly now: Date;
  readonly newId: () => string;
  readonly gate: RateGate;
  /** Rate gate key; the caller passes the Creator project id. */
  readonly rateKey: string;
}

export type CreatorStateFailure =
  | "not_found"
  | "invalid"
  | "duplicate"
  | "limit"
  | "rate_limited"
  | "reserved"
  | "sending"
  | "stale_shot"
  | "stale_proposal"
  | "already_sending"
  | "not_sending"
  | "not_halted"
  | "not_sent"
  | "not_resolved";

export interface StateOk<T> {
  readonly ok: true;
  readonly state: CreatorStoreFile;
  readonly value: T;
}
export interface StateFail {
  readonly ok: false;
  readonly reason: CreatorStateFailure;
  /** Set only when refusing still changed the state (a stale proposal was voided). */
  readonly state?: CreatorStoreFile;
}
export type StateResult<T> = StateOk<T> | StateFail;

export const emptyCreatorState = (): CreatorStoreFile => ({
  version: 1,
  revision: 0,
  nextNumber: 1,
  comments: [],
  proposals: [],
  history: [],
  reservations: {},
});

/** UTF-8 bytes of the JSON the store would write. Enforcement happens before writing. */
export const byteSizeOfStore = (state: CreatorStoreFile): number =>
  new TextEncoder().encode(JSON.stringify(state)).byteLength;

const isPlace = Schema.is(CreatorPlace);

const ok = <T>(state: CreatorStoreFile, value: T): StateOk<T> => ({ ok: true, state, value });
const fail = (reason: CreatorStateFailure, state?: CreatorStoreFile): StateFail =>
  state === undefined ? { ok: false, reason } : { ok: false, reason, state };

const iso = (ctx: CreatorStateContext) => ctx.now.toISOString();
const bump = (state: CreatorStoreFile): CreatorStoreFile => ({
  ...state,
  revision: state.revision + 1,
});
const shortReason = (reason: string | null | undefined): string | null =>
  reason == null ? null : reason.slice(0, CREATOR_LIMITS.maxField);

const validComment = (text: string) => text.length <= CREATOR_LIMITS.maxComment;
const validTimeSec = (timeSec: number) => Number.isFinite(timeSec) && timeSec >= 0;

/**
 * `id:revision` joined by `|`. The contract caps the key at 200 characters, which
 * fits only 5 UUID-shaped ids, so longer keys fall back to a hash of the same string.
 */
export const revisionKeyOf = (
  items: ReadonlyArray<{ readonly commentId: string; readonly revision: number }>,
): string => {
  const joined = items.map((item) => `${item.commentId}:${item.revision}`).join("|");
  if (joined.length <= CREATOR_LIMITS.maxField) return joined;
  return `sha256:${NodeCrypto.createHash("sha256").update(joined).digest("hex")}`;
};

const mapComments = (
  comments: ReadonlyArray<CreatorComment>,
  ids: ReadonlySet<string>,
  change: (comment: CreatorComment) => CreatorComment,
): ReadonlyArray<CreatorComment> =>
  comments.map((comment) => (ids.has(comment.id) ? change(comment) : comment));

const withoutReservations = (
  reservations: CreatorStoreFile["reservations"],
  proposalId: CreatorProposalId,
): CreatorStoreFile["reservations"] =>
  Object.fromEntries(Object.entries(reservations).filter(([, held]) => held !== proposalId));

const compactEntry = (
  proposal: CreatorProposal,
  outcome: CreatorProposalOutcome,
  ctx: CreatorStateContext,
  reason: string | null,
): CreatorProposalHistory => ({
  id: proposal.id,
  bindingId: proposal.bindingId,
  commandId: proposal.send?.commandId ?? null,
  messageId: proposal.send?.messageId ?? null,
  outcome,
  reason,
  finishedAt: iso(ctx),
});

/**
 * Finish a proposal: drop it and its reservations, push its compact record into the
 * history (newest first, trimmed), and move its comments with `settle`.
 */
const finishProposal = (
  state: CreatorStoreFile,
  proposal: CreatorProposal,
  outcome: CreatorProposalOutcome,
  ctx: CreatorStateContext,
  options: {
    readonly reason?: string | null;
    readonly settle: (comment: CreatorComment, item: CreatorProposalItem) => CreatorComment;
  },
): CreatorStoreFile => {
  const items = new Map(proposal.items.map((item) => [item.commentId as string, item]));
  const held = new Set(
    proposal.items
      .filter((item) => state.reservations[item.commentId] === proposal.id)
      .map((item) => item.commentId as string),
  );
  return {
    ...state,
    comments: state.comments.map((comment) => {
      const item = items.get(comment.id);
      return item !== undefined && held.has(comment.id) ? options.settle(comment, item) : comment;
    }),
    proposals: state.proposals.filter((entry) => entry.id !== proposal.id),
    reservations: withoutReservations(state.reservations, proposal.id),
    history: [
      compactEntry(proposal, outcome, ctx, shortReason(options.reason)),
      ...state.history,
    ].slice(0, CREATOR_LIMITS.maxHistory),
  };
};

const backToDraft = (comment: CreatorComment): CreatorComment => ({ ...comment, status: "draft" });

/** Void a pending proposal (an edit invalidated what the user approved). */
const voidProposal = (
  state: CreatorStoreFile,
  proposal: CreatorProposal,
  ctx: CreatorStateContext,
): CreatorStoreFile => finishProposal(state, proposal, "voided", ctx, { settle: backToDraft });

const findComment = (state: CreatorStoreFile, id: CreatorCommentId) =>
  state.comments.find((comment) => comment.id === id);

const findProposal = (state: CreatorStoreFile, id: CreatorProposalId) =>
  state.proposals.find((proposal) => proposal.id === id);

/**
 * Shared edit path (`gated` edits share the "draft" rate window with createDraft). Refuses while sending; a reserved comment voids its proposal
 * first; `sent` and later keep their status (the UI compares `sentVersion`).
 */
const editComment = (
  state: CreatorStoreFile,
  id: CreatorCommentId,
  ctx: CreatorStateContext,
  change: (comment: CreatorComment) => CreatorComment,
  options: { readonly gated: boolean } = { gated: false },
): StateResult<CreatorComment> => {
  const current = findComment(state, id);
  if (current === undefined) return fail("not_found");
  if (current.status === "sending") return fail("sending");
  // Last check, so a refused call never uses a slot of the shared draft window.
  if (options.gated && !ctx.gate.allow(ctx.rateKey, "draft", ctx.now.getTime())) {
    return fail("rate_limited");
  }
  const voided = releaseReservedComment(state, current, ctx);
  const base = findComment(voided, id) ?? current;
  const next: CreatorComment = { ...change(base), revision: base.revision + 1 };
  return ok(
    bump({
      ...voided,
      comments: voided.comments.map((comment) => (comment.id === id ? next : comment)),
    }),
    next,
  );
};

/** If the comment is reserved by a pending proposal, void that proposal. */
const releaseReservedComment = (
  state: CreatorStoreFile,
  comment: CreatorComment,
  ctx: CreatorStateContext,
): CreatorStoreFile => {
  const holder = state.reservations[comment.id];
  if (holder === undefined) {
    return comment.status === "proposed"
      ? {
          ...state,
          comments: state.comments.map((entry) =>
            entry.id === comment.id ? backToDraft(entry) : entry,
          ),
        }
      : state;
  }
  const proposal = findProposal(state, holder);
  if (proposal === undefined) {
    const { [comment.id]: _dropped, ...rest } = state.reservations;
    return {
      ...state,
      reservations: rest,
      comments: state.comments.map((entry) =>
        entry.id === comment.id && entry.status === "proposed" ? backToDraft(entry) : entry,
      ),
    };
  }
  return voidProposal(state, proposal, ctx);
};

export const createDraft = (
  state: CreatorStoreFile,
  input: {
    readonly timeSec: number;
    readonly projectRevision: string;
    readonly comment?: string;
    readonly place?: CreatorPlace | null;
  },
  ctx: CreatorStateContext,
): StateResult<CreatorComment> => {
  const projectRevision = input.projectRevision.trim();
  const comment = input.comment ?? "";
  const place = input.place ?? null;
  if (
    !validTimeSec(input.timeSec) ||
    projectRevision.length === 0 ||
    projectRevision.length > CREATOR_LIMITS.maxField ||
    !validComment(comment) ||
    (place !== null && !isPlace(place))
  ) {
    return fail("invalid");
  }
  if (state.comments.length >= CREATOR_LIMITS.maxComments) return fail("limit");
  if (!ctx.gate.allow(ctx.rateKey, "draft", ctx.now.getTime())) return fail("rate_limited");
  const created: CreatorComment = {
    id: ctx.newId() as CreatorCommentId,
    number: state.nextNumber,
    timeSec: input.timeSec,
    place,
    comment,
    revision: 1,
    status: "draft",
    shot: null,
    projectRevision,
    createdAt: iso(ctx),
    sentAt: null,
    sentMessageId: null,
    sentVersion: null,
    resolvedNote: null,
  };
  return ok(
    bump({ ...state, nextNumber: state.nextNumber + 1, comments: [...state.comments, created] }),
    created,
  );
};

/** `saveDraft` with an id: replace text, place and position in one gated edit. */
export const replaceDraft = (
  state: CreatorStoreFile,
  input: {
    readonly id: CreatorCommentId;
    readonly timeSec: number;
    readonly projectRevision: string;
    readonly comment: string;
    readonly place: CreatorPlace | null;
  },
  ctx: CreatorStateContext,
): StateResult<CreatorComment> => {
  const projectRevision = input.projectRevision.trim();
  if (
    !validTimeSec(input.timeSec) ||
    projectRevision.length === 0 ||
    projectRevision.length > CREATOR_LIMITS.maxField ||
    !validComment(input.comment) ||
    (input.place !== null && !isPlace(input.place))
  ) {
    return fail("invalid");
  }
  return editComment(
    state,
    input.id,
    ctx,
    (comment) => ({
      ...comment,
      timeSec: input.timeSec,
      projectRevision,
      comment: input.comment,
      place: input.place,
    }),
    { gated: true },
  );
};

export const updateComment = (
  state: CreatorStoreFile,
  input: { readonly id: CreatorCommentId; readonly comment: string },
  ctx: CreatorStateContext,
): StateResult<CreatorComment> => {
  if (!validComment(input.comment)) return fail("invalid");
  return editComment(state, input.id, ctx, (comment) => ({ ...comment, comment: input.comment }), {
    gated: true,
  });
};

export const setPlace = (
  state: CreatorStoreFile,
  input: { readonly id: CreatorCommentId; readonly place: CreatorPlace | null },
  ctx: CreatorStateContext,
): StateResult<CreatorComment> => {
  if (input.place !== null && !isPlace(input.place)) return fail("invalid");
  return editComment(state, input.id, ctx, (comment) => ({ ...comment, place: input.place }), {
    gated: true,
  });
};

/** Accepts the shot only if it was taken for the comment's current revision. */
export const attachShot = (
  state: CreatorStoreFile,
  input: { readonly id: CreatorCommentId; readonly shot: CreatorShotRef },
  ctx: CreatorStateContext,
): StateResult<CreatorComment> => {
  const current = findComment(state, input.id);
  if (current === undefined) return fail("not_found");
  if (input.shot.commentId !== input.id) return fail("invalid");
  if (current.status === "sending") return fail("sending");
  if (input.shot.revision !== current.revision) return fail("stale_shot");
  return editComment(state, input.id, ctx, (comment) => ({ ...comment, shot: input.shot }));
};

/** Deleting a reserved comment voids its proposal first; refused while sending. */
export const deleteComment = (
  state: CreatorStoreFile,
  input: { readonly id: CreatorCommentId },
  ctx: CreatorStateContext,
): StateResult<{ readonly voidedProposalId: CreatorProposalId | null }> => {
  const current = findComment(state, input.id);
  if (current === undefined) return fail("not_found");
  if (current.status === "sending") return fail("sending");
  const holder = state.reservations[input.id];
  const voidedProposalId =
    holder !== undefined && findProposal(state, holder) !== undefined ? holder : null;
  const base = releaseReservedComment(state, current, ctx);
  const { [input.id]: _dropped, ...reservations } = base.reservations;
  return ok(
    bump({
      ...base,
      reservations,
      comments: base.comments.filter((comment) => comment.id !== input.id),
    }),
    { voidedProposalId },
  );
};

export const propose = (
  state: CreatorStoreFile,
  input: {
    readonly ids: ReadonlyArray<CreatorCommentId>;
    readonly destination: CreatorDestination;
    readonly bindingId: CreatorBindingId;
  },
  ctx: CreatorStateContext,
): StateResult<CreatorProposal> => {
  if (input.ids.length === 0 || input.ids.length > CREATOR_LIMITS.maxProposalItems) {
    return fail("invalid");
  }
  if (new Set(input.ids).size !== input.ids.length) return fail("duplicate");
  const picked: CreatorComment[] = [];
  for (const id of input.ids) {
    const comment = findComment(state, id);
    if (comment === undefined) return fail("not_found");
    if (comment.status === "sending") return fail("sending");
    if (comment.status === "proposed" || state.reservations[id] !== undefined) {
      return fail("reserved");
    }
    picked.push(comment);
  }
  if (!ctx.gate.allow(ctx.rateKey, "propose", ctx.now.getTime())) return fail("rate_limited");
  const items: CreatorProposalItem[] = picked.map((comment) => ({
    commentId: comment.id,
    revision: comment.revision,
    number: comment.number,
    timeSec: comment.timeSec,
    comment: comment.comment,
    place: comment.place,
    shot: comment.shot,
  }));
  const proposal: CreatorProposal = {
    id: ctx.newId() as CreatorProposalId,
    bindingId: input.bindingId,
    destination: input.destination,
    items,
    revisionKey: revisionKeyOf(items),
    createdAt: iso(ctx),
    send: null,
  };
  const held = new Set<string>(input.ids);
  return ok(
    bump({
      ...state,
      comments: mapComments(state.comments, held, (comment) => ({
        ...comment,
        status: "proposed",
      })),
      proposals: [...state.proposals, proposal],
      reservations: {
        ...state.reservations,
        ...Object.fromEntries(input.ids.map((id) => [id, proposal.id])),
      },
    }),
    proposal,
  );
};

/** Only a proposal that has not started sending can be cancelled. */
export const cancelProposal = (
  state: CreatorStoreFile,
  input: { readonly proposalId: CreatorProposalId },
  ctx: CreatorStateContext,
): StateResult<CreatorProposal> => {
  const proposal = findProposal(state, input.proposalId);
  if (proposal === undefined) return fail("not_found");
  if (proposal.send !== null) return fail("already_sending");
  return ok(
    bump(finishProposal(state, proposal, "cancelled", ctx, { settle: backToDraft })),
    proposal,
  );
};

/**
 * Pin the send record to the proposal. The caller's `revisionKey` must be the
 * proposal's, and every comment must still be reserved at the pinned revision;
 * otherwise the proposal is voided and the send refused.
 */
export const beginSend = (
  state: CreatorStoreFile,
  input: {
    readonly proposalId: CreatorProposalId;
    readonly revisionKey: string;
    readonly record: CreatorSendRecord;
  },
  ctx: CreatorStateContext,
): StateResult<CreatorProposal> => {
  const proposal = findProposal(state, input.proposalId);
  if (proposal === undefined) return fail("not_found");
  if (proposal.send !== null) return fail("already_sending");
  if (input.record.state !== "sending") return fail("invalid");
  const intact =
    input.revisionKey === proposal.revisionKey &&
    proposal.items.every((item) => {
      const comment = findComment(state, item.commentId);
      return (
        state.reservations[item.commentId] === proposal.id &&
        comment !== undefined &&
        comment.status === "proposed" &&
        comment.revision === item.revision
      );
    });
  if (!intact) {
    return fail("stale_proposal", bump(voidProposal(state, proposal, ctx)));
  }
  const started: CreatorProposal = { ...proposal, send: input.record };
  const held = new Set<string>(proposal.items.map((item) => item.commentId));
  return ok(
    bump({
      ...state,
      comments: mapComments(state.comments, held, (comment) => ({ ...comment, status: "sending" })),
      proposals: state.proposals.map((entry) => (entry.id === proposal.id ? started : entry)),
    }),
    started,
  );
};

/**
 * accepted: comments become `sent` with their pinned content as `sentVersion`.
 * rejected: back to `draft`. conflict: stays `sending` with the reservation kept
 * (no automatic resend; the user decides). The result value is the proposal as it
 * was when it finished (for conflict, the updated live proposal).
 */
export const finishSend = (
  state: CreatorStoreFile,
  input: {
    readonly proposalId: CreatorProposalId;
    readonly outcome: "accepted" | "rejected" | "conflict";
    readonly reason?: string | null;
  },
  ctx: CreatorStateContext,
): StateResult<CreatorProposal> => {
  const proposal = findProposal(state, input.proposalId);
  if (proposal === undefined) return fail("not_found");
  const send = proposal.send;
  if (send === null) return fail("not_sending");
  const reason = input.reason ?? null;
  if (input.outcome === "conflict") {
    const updated: CreatorProposal = { ...proposal, send: { ...send, state: "conflict", reason } };
    return ok(
      bump({
        ...state,
        proposals: state.proposals.map((entry) => (entry.id === proposal.id ? updated : entry)),
      }),
      updated,
    );
  }
  if (input.outcome === "rejected") {
    return ok(
      bump(finishProposal(state, proposal, "rejected", ctx, { reason, settle: backToDraft })),
      proposal,
    );
  }
  return ok(
    bump(
      finishProposal(state, proposal, "accepted", ctx, {
        settle: (comment, item) => ({
          ...comment,
          status: "sent",
          sentAt: iso(ctx),
          sentMessageId: send.messageId,
          sentVersion: {
            comment: item.comment,
            place: item.place,
            shot: item.shot,
            revision: item.revision,
          },
          resolvedNote: null,
        }),
      }),
    ),
    proposal,
  );
};

const updateSend = (
  state: CreatorStoreFile,
  proposalId: CreatorProposalId,
  change: (send: CreatorSendRecord) => CreatorSendRecord | CreatorStateFailure,
): StateResult<CreatorProposal> => {
  const proposal = findProposal(state, proposalId);
  if (proposal === undefined) return fail("not_found");
  if (proposal.send === null) return fail("not_sending");
  const next = change(proposal.send);
  if (typeof next === "string") return fail(next);
  const updated: CreatorProposal = { ...proposal, send: next };
  return ok(
    bump({
      ...state,
      proposals: state.proposals.map((entry) => (entry.id === proposalId ? updated : entry)),
    }),
    updated,
  );
};

/** One more resend attempt; the third makes the send `stuck`. Only a `sending` send counts. */
export const markAttempt = (
  state: CreatorStoreFile,
  input: { readonly proposalId: CreatorProposalId },
  _ctx?: CreatorStateContext,
): StateResult<CreatorProposal> =>
  updateSend(state, input.proposalId, (send) => {
    if (send.state !== "sending") return "not_sending";
    const attempts = send.attempts + 1;
    return {
      ...send,
      attempts,
      state: attempts >= CREATOR_MAX_SEND_ATTEMPTS ? "stuck" : "sending",
    };
  });

/** Records why a started send is still open (for example, its outcome could not be verified). */
export const noteSendReason = (
  state: CreatorStoreFile,
  input: { readonly proposalId: CreatorProposalId; readonly reason: string | null },
  _ctx?: CreatorStateContext,
): StateResult<CreatorProposal> =>
  updateSend(state, input.proposalId, (send) => ({ ...send, reason: input.reason }));

/** The user asked to stop resending. Reservation and pinned content stay. Idempotent. */
export const requestHalt = (
  state: CreatorStoreFile,
  input: { readonly proposalId: CreatorProposalId },
  _ctx?: CreatorStateContext,
): StateResult<CreatorProposal> =>
  updateSend(state, input.proposalId, (send) => ({
    ...send,
    haltRequested: true,
    state: "halted",
  }));

/**
 * Give up a `halted` or `stuck` send: comments go back to `draft`, the reservation is
 * released and the proposal is recorded as rejected (reason "halted"). The caller
 * must already have verified that nothing is in flight, no acceptance record exists
 * and the thread has no message with this id.
 */
export const releaseHalted = (
  state: CreatorStoreFile,
  input: { readonly proposalId: CreatorProposalId },
  ctx: CreatorStateContext,
): StateResult<CreatorProposal> => {
  const proposal = findProposal(state, input.proposalId);
  if (proposal === undefined) return fail("not_found");
  if (proposal.send === null) return fail("not_sending");
  if (proposal.send.state !== "halted" && proposal.send.state !== "stuck")
    return fail("not_halted");
  return ok(
    bump(
      finishProposal(state, proposal, "rejected", ctx, { reason: "halted", settle: backToDraft }),
    ),
    proposal,
  );
};

const moveStatus = (
  state: CreatorStoreFile,
  ids: ReadonlyArray<CreatorCommentId>,
  from: CreatorCommentStatus,
  failure: CreatorStateFailure,
  change: (comment: CreatorComment) => CreatorComment,
): StateResult<null> => {
  if (ids.length === 0 || new Set(ids).size !== ids.length) return fail("invalid");
  for (const id of ids) {
    const comment = findComment(state, id);
    if (comment === undefined) return fail("not_found");
    if (comment.status !== from) return fail(failure);
  }
  const picked = new Set<string>(ids);
  return ok(bump({ ...state, comments: mapComments(state.comments, picked, change) }), null);
};

/** `sent` comments become `resolved` with the AI's note. */
export const resolve = (
  state: CreatorStoreFile,
  input: { readonly ids: ReadonlyArray<CreatorCommentId>; readonly note: string },
  _ctx?: CreatorStateContext,
): StateResult<null> => {
  if (input.note.length > CREATOR_LIMITS.maxComment) return fail("invalid");
  return moveStatus(state, input.ids, "sent", "not_sent", (comment) => ({
    ...comment,
    status: "resolved",
    resolvedNote: input.note,
  }));
};

/** The user confirms `resolved` comments. */
export const confirmByUser = (
  state: CreatorStoreFile,
  input: { readonly ids: ReadonlyArray<CreatorCommentId> },
  _ctx?: CreatorStateContext,
): StateResult<null> =>
  moveStatus(state, input.ids, "resolved", "not_resolved", (comment) => ({
    ...comment,
    status: "confirmed",
  }));
