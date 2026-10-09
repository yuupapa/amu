/**
 * Creator - Schemas for Amu Creator, the review-comment layer on top of an
 * in-app HyperFrames Studio tab.
 *
 * The server is the only writer. It keeps bindings (the unit of authority issued
 * each time a Creator tab is opened), comment state, proposals with their
 * reservations, and send records. Clients and the guest page can only draft,
 * propose and request captures; sending happens on the server.
 *
 * IDs that end up in file names (`CreatorCommentId`, `CreatorProposalId`,
 * `CreatorBindingId`, `CreatorProjectId`) are server-issued and validated to a
 * path-safe shape here, so a name can never carry a separator or `..`.
 *
 * Finished proposals (accepted, rejected, voided, cancelled) are compacted into
 * `CreatorProposalHistory` records kept in `CreatorStoreFile.history`, so a
 * project that has been used for a long time stays under the `comments.json`
 * size limit.
 *
 * @module Creator
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ChatAttachment, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "./chatAttachment.ts";

export const CREATOR_LIMITS = {
  /** One guest -> main message. */
  maxMessageBytes: 256 * 1024,
  /** Comment text, in characters. */
  maxComment: 2_000,
  /** Any other string part of a comment (selector, label, file, revision). */
  maxField: 200,
  /** Comments in one project. */
  maxComments: 200,
  /** `comments.json`, checked in UTF-8 bytes before writing. */
  maxStoreBytes: 4_194_304,
  /** One screenshot (PNG). */
  maxShotBytes: 3 * 1024 * 1024,
  /** Longest screenshot edge, in pixels. */
  maxShotEdge: 1_280,
  /** All screenshots of one project. */
  maxShotsTotalBytes: 50 * 1024 * 1024,
  /** Comment create/update: at most `commentRateMax` per `commentRateWindowMs`. */
  commentRateMax: 2,
  commentRateWindowMs: 1_000,
  /** One proposal per this many ms, with at most `maxProposalItems` comments. */
  proposeIntervalMs: 2_000,
  maxProposalItems: 30,
  /** Finished proposals kept (newest first) as compacted history. */
  maxHistory: 200,
  /** A capture is abandoned after this long; one at a time. */
  captureTimeoutMs: 5_000,
  /** Waiting for HyperFrames to print its ready line. */
  hyperframesStartTimeoutMs: 60_000,
  /** HyperFrames previews running at once, counting ones still starting. */
  maxPreviews: 3,
} as const;

const UUID_V4_LIKE = /^[0-9a-f-]{36}$/;
const PROJECT_ID = /^[a-f0-9]{32}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Server-issued, lowercase UUID. Used in file names, so nothing else is accepted. */
export const CreatorCommentId = Schema.String.check(Schema.isPattern(UUID_V4_LIKE)).pipe(
  Schema.brand("CreatorCommentId"),
);
export type CreatorCommentId = typeof CreatorCommentId.Type;
export const CreatorProposalId = Schema.String.check(Schema.isPattern(UUID_V4_LIKE)).pipe(
  Schema.brand("CreatorProposalId"),
);
export type CreatorProposalId = typeof CreatorProposalId.Type;
/** A binding is the authority granted by one `open`; it dies with the tab. */
export const CreatorBindingId = Schema.String.check(Schema.isPattern(UUID_V4_LIKE)).pipe(
  Schema.brand("CreatorBindingId"),
);
export type CreatorBindingId = typeof CreatorBindingId.Type;
/** Stable id of a reviewed project (32 hex chars derived by the server). */
export const CreatorProjectId = Schema.String.check(Schema.isPattern(PROJECT_ID)).pipe(
  Schema.brand("CreatorProjectId"),
);
export type CreatorProjectId = typeof CreatorProjectId.Type;

/** Monotonic per binding; bumped by the desktop main on every revoke and activate. */
export const CreatorEpoch = NonNegativeInt;
export type CreatorEpoch = typeof CreatorEpoch.Type;

const Field = Schema.String.check(Schema.isMaxLength(CREATOR_LIMITS.maxField));
const NullableField = Schema.NullOr(Field);

/** Relative path of an `.html` composition: no `..`, no leading `/`, no backslash or control chars. */
export const CreatorCompositionFile = Field.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((value: string) => {
    if (value.includes("..")) return "must not contain '..'";
    if (value.startsWith("/")) return "must be a relative path";
    if (value.includes("\\")) return "must not contain backslashes";
    if ([...value].some((char) => char.charCodeAt(0) < 0x20)) {
      return "must not contain control characters";
    }
    if (!value.endsWith(".html")) return "must end with .html";
    return undefined;
  }),
);

const Unit = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

export const CreatorPlace = Schema.Struct({
  x: Unit,
  y: Unit,
  compositionFile: Schema.NullOr(CreatorCompositionFile),
  elementSelector: NullableField,
  elementLabel: NullableField,
});
export type CreatorPlace = typeof CreatorPlace.Type;

export const CreatorShotRef = Schema.Struct({
  commentId: CreatorCommentId,
  revision: PositiveInt,
  sha256: Schema.String.check(Schema.isPattern(SHA256_HEX)),
  width: PositiveInt.check(Schema.isLessThanOrEqualTo(CREATOR_LIMITS.maxShotEdge)),
  height: PositiveInt.check(Schema.isLessThanOrEqualTo(CREATOR_LIMITS.maxShotEdge)),
});
export type CreatorShotRef = typeof CreatorShotRef.Type;

const CommentText = Schema.String.check(Schema.isMaxLength(CREATOR_LIMITS.maxComment));
/** Comment text arriving over RPC: trimmed and not empty. */
export const CreatorCommentInputText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CREATOR_LIMITS.maxComment),
);
const TimeSec = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

export const CreatorCommentStatus = Schema.Literals([
  "draft",
  "proposed",
  "sending",
  "sent",
  "resolved",
  "confirmed",
]);
export type CreatorCommentStatus = typeof CreatorCommentStatus.Type;

export const CreatorSentVersion = Schema.Struct({
  comment: CommentText,
  place: Schema.NullOr(CreatorPlace),
  shot: Schema.NullOr(CreatorShotRef),
  revision: PositiveInt,
});
export type CreatorSentVersion = typeof CreatorSentVersion.Type;

export const CreatorComment = Schema.Struct({
  id: CreatorCommentId,
  number: PositiveInt,
  timeSec: TimeSec,
  place: Schema.NullOr(CreatorPlace),
  comment: CommentText,
  revision: PositiveInt,
  status: CreatorCommentStatus,
  shot: Schema.NullOr(CreatorShotRef),
  projectRevision: TrimmedNonEmptyString.check(Schema.isMaxLength(CREATOR_LIMITS.maxField)),
  createdAt: IsoDateTime,
  sentAt: Schema.NullOr(IsoDateTime),
  sentMessageId: Schema.NullOr(MessageId),
  sentVersion: Schema.NullOr(CreatorSentVersion),
  resolvedNote: Schema.NullOr(Schema.String.check(Schema.isMaxLength(CREATOR_LIMITS.maxComment))),
});
export type CreatorComment = typeof CreatorComment.Type;

export const CreatorSendState = Schema.Literals([
  "sending",
  "accepted",
  "rejected",
  "conflict",
  "stuck",
  "halted",
]);
export type CreatorSendState = typeof CreatorSendState.Type;

export const CreatorSendRecord = Schema.Struct({
  commandId: CommandId,
  messageId: MessageId,
  text: Schema.String,
  /** Deterministic attachment ids, so a retry reuses the same ones. */
  attachments: Schema.Array(ChatAttachment).check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  ),
  state: CreatorSendState,
  reason: Schema.NullOr(Schema.String),
  attemptedAt: IsoDateTime,
  /** Resends so far; survives restarts. `stuck` after 3. */
  attempts: NonNegativeInt,
  /** The user asked to stop resending; reservation and pinned content are kept. */
  haltRequested: Schema.Boolean,
});
export type CreatorSendRecord = typeof CreatorSendRecord.Type;

export const CreatorProposalItem = Schema.Struct({
  commentId: CreatorCommentId,
  revision: PositiveInt,
  number: PositiveInt,
  timeSec: TimeSec,
  comment: CommentText,
  place: Schema.NullOr(CreatorPlace),
  shot: Schema.NullOr(CreatorShotRef),
});
export type CreatorProposalItem = typeof CreatorProposalItem.Type;

export const CreatorDestination = Schema.Struct({
  environmentId: EnvironmentId,
  /** The orchestration project of the thread (not the Creator project). */
  projectId: ProjectId,
  threadId: ThreadId,
});
export type CreatorDestination = typeof CreatorDestination.Type;

/** A live (pending or sending) proposal. Finished ones become `CreatorProposalHistory`. */
export const CreatorProposal = Schema.Struct({
  id: CreatorProposalId,
  bindingId: CreatorBindingId,
  destination: CreatorDestination,
  items: Schema.Array(CreatorProposalItem).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CREATOR_LIMITS.maxProposalItems),
  ),
  revisionKey: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(CREATOR_LIMITS.maxField),
  ),
  createdAt: IsoDateTime,
  send: Schema.NullOr(CreatorSendRecord),
});
export type CreatorProposal = typeof CreatorProposal.Type;

export const CreatorProposalOutcome = Schema.Literals([
  "accepted",
  "rejected",
  "voided",
  "cancelled",
]);
export type CreatorProposalOutcome = typeof CreatorProposalOutcome.Type;

/** A finished proposal with its pinned content and images dropped. */
export const CreatorProposalHistory = Schema.Struct({
  id: CreatorProposalId,
  bindingId: CreatorBindingId,
  commandId: Schema.NullOr(CommandId),
  messageId: Schema.NullOr(MessageId),
  outcome: CreatorProposalOutcome,
  /** Why a proposal was rejected (kept short). */
  reason: Schema.optional(NullableField),
  finishedAt: IsoDateTime,
});
export type CreatorProposalHistory = typeof CreatorProposalHistory.Type;

export const CreatorStoreFile = Schema.Struct({
  version: Schema.Literal(1),
  revision: NonNegativeInt,
  nextNumber: PositiveInt,
  comments: Schema.Array(CreatorComment),
  proposals: Schema.Array(CreatorProposal),
  /** Compacted finished proposals, newest first, at most `CREATOR_LIMITS.maxHistory`. */
  history: Schema.Array(CreatorProposalHistory).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** Which proposal currently holds each comment. */
  reservations: Schema.Record(CreatorCommentId, CreatorProposalId),
});
export type CreatorStoreFile = typeof CreatorStoreFile.Type;

/** Carried on the preview snapshot only. The public `PreviewOpenInput` has no such field. */
export const CreatorTabInfo = Schema.Struct({
  bindingId: CreatorBindingId,
  label: Field,
});
export type CreatorTabInfo = typeof CreatorTabInfo.Type;

/** What a client sees of one project: current state, without screenshots. */
export const CreatorSnapshot = Schema.Struct({
  projectId: CreatorProjectId,
  revision: NonNegativeInt,
  comments: Schema.Array(CreatorComment),
  proposals: Schema.Array(CreatorProposal),
});
export type CreatorSnapshot = typeof CreatorSnapshot.Type;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Every operation fails with this while `amuCreatorEnabled` is false. */
export class CreatorDisabledError extends Schema.TaggedError<CreatorDisabledError>()(
  "CreatorDisabledError",
  {},
) {
  override get message() {
    return "Amu Creator is turned off on this environment.";
  }
}

export const CreatorOperationErrorCode = Schema.Literals([
  "not_implemented",
  "unauthorized",
  "stale_epoch",
  "stale_revision",
  "not_found",
  "invalid",
  "limit",
  "conflict",
  "unavailable",
]);
export type CreatorOperationErrorCode = typeof CreatorOperationErrorCode.Type;

export class CreatorOperationError extends Schema.TaggedError<CreatorOperationError>()(
  "CreatorOperationError",
  { code: CreatorOperationErrorCode, detail: Schema.String },
) {
  override get message() {
    return `Amu Creator: ${this.code}: ${this.detail}`;
  }
}

export const CreatorError = Schema.Union([CreatorDisabledError, CreatorOperationError]);
export type CreatorError = typeof CreatorError.Type;

// ---------------------------------------------------------------------------
// RPC inputs. Every input except `openByUser` carries `{ bindingId, epoch }`
// and never a path. `epoch` must match the newest epoch the server knows for
// the binding (set by `setEpoch`), otherwise the call is refused.
// ---------------------------------------------------------------------------

const Binding = { bindingId: CreatorBindingId, epoch: CreatorEpoch } as const;

export const CreatorOpenByUserInput = Schema.Struct({
  threadId: ThreadId,
  /** Absolute path of the project directory, an index.html, or an mp4 chosen by the user. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
});
export type CreatorOpenByUserInput = typeof CreatorOpenByUserInput.Type;

export const CreatorOpenResult = Schema.Struct({
  bindingId: CreatorBindingId,
  projectId: CreatorProjectId,
  epoch: CreatorEpoch,
  tabId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
});
export type CreatorOpenResult = typeof CreatorOpenResult.Type;

export const CreatorSetEpochInput = Schema.Struct({
  ...Binding,
  /** Document generation owned by the desktop main; `null` means revoked. */
  generation: Schema.NullOr(NonNegativeInt),
});
export type CreatorSetEpochInput = typeof CreatorSetEpochInput.Type;

export const CreatorSaveDraftInput = Schema.Struct({
  ...Binding,
  /** Omit to create a comment; give it to replace the draft's content. */
  commentId: Schema.optional(CreatorCommentId),
  timeSec: TimeSec,
  comment: CreatorCommentInputText,
  place: Schema.NullOr(CreatorPlace),
  projectRevision: TrimmedNonEmptyString.check(Schema.isMaxLength(CREATOR_LIMITS.maxField)),
});
export type CreatorSaveDraftInput = typeof CreatorSaveDraftInput.Type;

export const CreatorUpdateCommentInput = Schema.Struct({
  ...Binding,
  commentId: CreatorCommentId,
  /** The revision the caller saw; a mismatch is refused. */
  expectedRevision: PositiveInt,
  comment: CreatorCommentInputText,
});
export type CreatorUpdateCommentInput = typeof CreatorUpdateCommentInput.Type;

export const CreatorSetPlaceInput = Schema.Struct({
  ...Binding,
  commentId: CreatorCommentId,
  expectedRevision: PositiveInt,
  place: Schema.NullOr(CreatorPlace),
});
export type CreatorSetPlaceInput = typeof CreatorSetPlaceInput.Type;

/** PNG bytes. On the JSON wire they travel as a base64 string. */
export const CreatorPngBytes = Schema.Uint8ArrayFromBase64.check(
  Schema.makeFilter((bytes: Uint8Array) =>
    bytes.byteLength > 0 && bytes.byteLength <= CREATOR_LIMITS.maxShotBytes
      ? undefined
      : `a screenshot must be 1..${CREATOR_LIMITS.maxShotBytes} bytes`,
  ),
);

export const CreatorAttachShotInput = Schema.Struct({
  ...Binding,
  commentId: CreatorCommentId,
  expectedRevision: PositiveInt,
  png: CreatorPngBytes,
});
export type CreatorAttachShotInput = typeof CreatorAttachShotInput.Type;

export const CreatorDeleteCommentInput = Schema.Struct({
  ...Binding,
  commentId: CreatorCommentId,
});
export type CreatorDeleteCommentInput = typeof CreatorDeleteCommentInput.Type;

export const CreatorProposeInput = Schema.Struct({
  ...Binding,
  commentIds: Schema.Array(CreatorCommentId).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CREATOR_LIMITS.maxProposalItems),
  ),
});
export type CreatorProposeInput = typeof CreatorProposeInput.Type;

export const CreatorCancelProposalInput = Schema.Struct({
  ...Binding,
  proposalId: CreatorProposalId,
});
export type CreatorCancelProposalInput = typeof CreatorCancelProposalInput.Type;

export const CreatorConfirmSendInput = Schema.Struct({
  ...Binding,
  proposalId: CreatorProposalId,
  /** Must equal the proposal's `revisionKey`: what the user saw is what is sent. */
  revisionKey: Schema.String.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(CREATOR_LIMITS.maxField),
  ),
});
export type CreatorConfirmSendInput = typeof CreatorConfirmSendInput.Type;

export const CreatorHaltSendInput = Schema.Struct({
  ...Binding,
  proposalId: CreatorProposalId,
});
export type CreatorHaltSendInput = typeof CreatorHaltSendInput.Type;

export const CreatorSendResult = Schema.Struct({
  proposalId: CreatorProposalId,
  state: CreatorSendState,
  reason: Schema.NullOr(Schema.String),
});
export type CreatorSendResult = typeof CreatorSendResult.Type;

/** The user marks an AI-resolved comment as confirmed. */
export const CreatorConfirmByUserInput = Schema.Struct({
  ...Binding,
  commentId: CreatorCommentId,
});
export type CreatorConfirmByUserInput = typeof CreatorConfirmByUserInput.Type;

export const CreatorReadShotInput = Schema.Struct({
  ...Binding,
  commentId: CreatorCommentId,
  revision: PositiveInt,
});
export type CreatorReadShotInput = typeof CreatorReadShotInput.Type;

export const CreatorReadShotResult = Schema.Struct({
  shot: CreatorShotRef,
  png: CreatorPngBytes,
});
export type CreatorReadShotResult = typeof CreatorReadShotResult.Type;

export const CreatorListInput = Schema.Struct({ ...Binding });
export type CreatorListInput = typeof CreatorListInput.Type;

export const CreatorSubscribeInput = Schema.Struct({ ...Binding });
export type CreatorSubscribeInput = typeof CreatorSubscribeInput.Type;
