/**
 * CreatorSender: sends a confirmed Amu Creator proposal to its thread, and settles
 * sends whose outcome the server could not see.
 *
 * A send is pinned before it is dispatched: `beginSend` stores the send record
 * (command id, message id, text, attachment ids) in `comments.json`, so a retry
 * after a lost response or a restart dispatches exactly the same command. The
 * command id is derived from the proposal id, and the orchestrator's command
 * receipt is the proof of acceptance; `reconcile` reads it, checks the message
 * the thread actually holds against the record, and resends only when no
 * receipt exists.
 *
 * Locks: each proposal has a `Semaphore(1)` held for a send, a reconcile pass or
 * a resend. The project lock (`withProjectState`) is held only for the short state
 * transitions, never around `sendToThread`. `haltSend` never waits for the
 * proposal lock: it raises an in-memory signal and records `haltRequested`;
 * releasing the reservation happens under the proposal lock, and only when
 * nothing is in flight, no receipt exists and the thread has no message with
 * the id. A failed or timed-out query counts as "not proven".
 *
 * Every dispatch waits for the server's command-readiness gate and re-reads the
 * setting just before it goes out; automatic resends of one proposal are at
 * least 30 s apart (`attemptedAt`), however many triggers fire.
 */
import {
  ChatAttachmentId,
  CommandId,
  CreatorOperationError,
  MessageId,
  type ChatAttachment,
  type CreatorAcknowledgeConflictInput,
  type CreatorBindingId,
  type CreatorConfirmSendInput,
  type CreatorDestination,
  type CreatorError,
  type CreatorHaltSendInput,
  type CreatorOperationErrorCode,
  type CreatorProjectId,
  type CreatorProposal,
  type CreatorProposalId,
  type CreatorSendRecord,
  type CreatorSendResult,
  type CreatorStoreFile,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import { attachmentRelativePath, createDeterministicAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadMessageIntake from "../orchestration-v2/ThreadMessageIntake.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CreatorService from "./CreatorService.ts";
import { buildCreatorMessage } from "./creatorMessage.ts";
import {
  acknowledgeConflict as acknowledgeConflictState,
  beginSend,
  finishSend,
  markAttempt,
  noteSendReason,
  releaseHalted,
  requestHalt,
  type CreatorStateContext,
  type StateResult,
} from "./creatorState.ts";

/** A receipt or thread read that takes longer than this counts as failed. */
const QUERY_TIMEOUT = Duration.seconds(10);
/** How often open sends are reconciled while any exist. */
const POLL_INTERVAL = Duration.seconds(30);
/** Automatic resends of one proposal are at least this far apart, however often reconcile runs. */
const RESEND_PAUSE_MS = 30_000;
const PROJECT_DIR = /^[a-f0-9]{32}$/;

// Failures that prove the message was not accepted. The first three are raised
// before the command reaches the orchestrator; the rest are the orchestrator's
// receipt-validation and planning failures, which also precede the commit (the
// same list as ThreadMessageIntake's private `dispatchWasNotAccepted`).
// `ThreadManagementThreadNotFoundError` is not here: `sendToThread` reads the
// thread again after dispatching, so that error can follow a commit.
const NOT_ACCEPTED = new Set([
  "AttachmentClaimError",
  "ThreadManagementThreadArchivedError",
  "ThreadManagementNoSteerableRunError",
  "OrchestratorCommandRejectedError",
  "OrchestratorProjectionError",
  "OrchestratorProviderAdapterError",
  "OrchestratorCommandPreviouslyRejectedError",
  "OrchestratorCommandIdConflictError",
  "OrchestratorSubagentThreadReadOnlyError",
  "OrchestratorThreadAboveModeLimitError",
]);

/**
 * `rejected`: the message was definitely not accepted, so the comments can go back
 * to draft. `unknown`: it may have been committed (including interruptions and
 * defects); the send stays `sending` until a receipt says otherwise.
 */
export const classifySendFailure = (error: { readonly _tag: string }): "rejected" | "unknown" =>
  NOT_ACCEPTED.has(error._tag) ? "rejected" : "unknown";

export class CreatorSender extends Context.Service<
  CreatorSender,
  {
    /** Sends a proposal the user approved, after checking the binding, epoch and destination. */
    readonly confirmSend: (
      input: CreatorConfirmSendInput,
    ) => Effect.Effect<CreatorSendResult, CreatorError>;
    /** Stops resending at once; returns to draft only when the send provably did not land. */
    readonly haltSend: (
      input: CreatorHaltSendInput,
    ) => Effect.Effect<CreatorSendResult, CreatorError>;
    /** The user checked the thread after a `conflict`: finish it as sent. Only a conflict. */
    readonly acknowledgeConflict: (
      input: CreatorAcknowledgeConflictInput,
    ) => Effect.Effect<CreatorSendResult, CreatorError>;
    /** Settles every started send of the project; resends only while Creator is on. Never fails. */
    readonly reconcile: (projectId: CreatorProjectId) => Effect.Effect<void>;
    /** One periodic pass: reconciles projects that still have open sends. */
    readonly reconcileOpen: Effect.Effect<void>;
    /** Reconciles the binding's project in the background (when a client subscribes). */
    readonly reconcileInBackground: (bindingId: CreatorBindingId) => Effect.Effect<void>;
    /** Completes once the startup reconcile of stored projects has run. */
    readonly startupDone: Effect.Effect<void>;
  }
>()("t3/creator/CreatorSender") {}

type ReceiptProbe =
  | { readonly _tag: "none" }
  | { readonly _tag: "accepted" }
  | { readonly _tag: "rejected"; readonly error: string | null }
  | { readonly _tag: "unknown" };

type ThreadProbe =
  | {
      readonly _tag: "found";
      readonly archived: boolean;
      readonly message: OrchestrationV2ConversationMessage | undefined;
    }
  | { readonly _tag: "gone" }
  | { readonly _tag: "unknown" };

interface PinnedAttachment {
  readonly attachment: ChatAttachment;
  readonly bytes: Uint8Array;
}

const operationError = (code: CreatorOperationErrorCode, detail: string) =>
  new CreatorOperationError({ code, detail });

const sameContent = (record: CreatorSendRecord, message: OrchestrationV2ConversationMessage) =>
  message.text === record.text &&
  message.attachments.length === record.attachments.length &&
  message.attachments.every((attachment, index) => attachment.id === record.attachments[index]?.id);

const findProposal = (state: CreatorStoreFile, proposalId: CreatorProposalId) =>
  state.proposals.find((proposal) => proposal.id === proposalId);

/** The send's outcome as the store records it now. */
const outcomeOf = (state: CreatorStoreFile, proposalId: CreatorProposalId): CreatorSendResult => {
  const send = findProposal(state, proposalId)?.send;
  if (send) return { proposalId, state: send.state, reason: send.reason };
  const finished = state.history.find((entry) => entry.id === proposalId);
  if (finished?.outcome === "accepted") return { proposalId, state: "accepted", reason: null };
  return { proposalId, state: "rejected", reason: finished?.reason ?? finished?.outcome ?? null };
};

/** Runs `effect` with a timeout; a failure or timeout is logged and becomes `None`. */
const attempt = <A, E, R>(
  label: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Option.Option<A>, never, R> =>
  effect.pipe(
    Effect.timeoutOption(QUERY_TIMEOUT),
    Effect.exit,
    Effect.flatMap((exit): Effect.Effect<Option.Option<A>> => {
      if (Exit.isSuccess(exit)) {
        return Option.isSome(exit.value)
          ? Effect.succeed(exit.value)
          : Effect.logWarning(`Amu Creator ${label} timed out`).pipe(Effect.as(Option.none()));
      }
      if (Cause.hasInterruptsOnly(exit.cause)) return Effect.interrupt;
      return Effect.logWarning(`Amu Creator ${label} failed`, { cause: exit.cause }).pipe(
        Effect.as(Option.none()),
      );
    }),
  );

interface SenderOptions {
  /** Completes once the server accepts commands; every dispatch waits for it. */
  readonly commandGate: Effect.Effect<void, ServerRuntimeStartup.ServerRuntimeStartupError>;
  /** Interval of the periodic pass; null runs none (tests drive `reconcileOpen`). */
  readonly pollInterval: Duration.Duration | null;
}

const make = ({ commandGate, pollInterval }: SenderOptions) =>
  Effect.gen(function* () {
    const creator = yield* CreatorService.CreatorService;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const intake = yield* Effect.context<
      ThreadManagement.ThreadManagementService | ServerConfig.ServerConfig | FileSystem.FileSystem
    >();
    const scope = yield* Effect.scope;

    const locks = new Map<string, Semaphore.Semaphore>();
    const lockOf = (proposalId: CreatorProposalId) => {
      let lock = locks.get(proposalId);
      if (lock === undefined) {
        lock = Semaphore.makeUnsafe(1);
        locks.set(proposalId, lock);
      }
      return lock;
    };
    /** Proposals whose `sendToThread` call has not returned yet. */
    const inFlight = new Set<string>();
    const halts = new Map<string, Deferred.Deferred<void>>();
    const haltSignal = (proposalId: CreatorProposalId) => {
      let signal = halts.get(proposalId);
      if (signal === undefined) {
        signal = Deferred.makeUnsafe<void>();
        halts.set(proposalId, signal);
      }
      return signal;
    };
    const haltRequested = (proposalId: CreatorProposalId) => {
      const signal = halts.get(proposalId);
      return signal !== undefined && Deferred.isDoneUnsafe(signal);
    };
    /** Projects with a send that is not settled yet; the periodic pass visits these. */
    const openProjects = new Set<CreatorProjectId>();

    const readState = (projectId: CreatorProjectId) =>
      creator.withProjectState(projectId, (state) => Effect.succeed({ next: null, value: state }));

    /** Applies a transition under the project lock; a refusal that changed the state is kept too. */
    const apply = <V>(
      projectId: CreatorProjectId,
      transition: (state: CreatorStoreFile, ctx: CreatorStateContext) => StateResult<V>,
    ) =>
      creator.withProjectState(projectId, (state, ctx) =>
        Effect.sync(() => {
          const result = transition(state, ctx);
          return { next: result.ok ? result.state : (result.state ?? null), value: result };
        }),
      );

    const applyOrFail = <V>(
      projectId: CreatorProjectId,
      transition: (state: CreatorStoreFile, ctx: CreatorStateContext) => StateResult<V>,
    ) =>
      apply(projectId, transition).pipe(
        Effect.flatMap((result) =>
          result.ok
            ? Effect.succeed(result.value)
            : Effect.fail(CreatorService.creatorStateError(result.reason)),
        ),
      );

    /** Applies a transition and reports the proposal's outcome as stored afterwards. */
    const settle = (
      projectId: CreatorProjectId,
      proposalId: CreatorProposalId,
      transition: (state: CreatorStoreFile, ctx: CreatorStateContext) => StateResult<unknown>,
    ) =>
      creator.withProjectState(projectId, (state, ctx) =>
        Effect.sync(() => {
          const result = transition(state, ctx);
          const next = result.ok ? result.state : (result.state ?? null);
          return { next, value: outcomeOf(next ?? state, proposalId) };
        }),
      );

    const reject = (projectId: CreatorProjectId, proposalId: CreatorProposalId, reason: string) =>
      settle(projectId, proposalId, (state, ctx) =>
        finishSend(state, { proposalId, outcome: "rejected", reason }, ctx),
      );

    /** Acceptance counts only when the thread's message matches the record (else `conflict`). */
    const settleAccepted = (
      projectId: CreatorProjectId,
      proposalId: CreatorProposalId,
      record: CreatorSendRecord,
      message: OrchestrationV2ConversationMessage | undefined,
    ) =>
      settle(projectId, proposalId, (state, ctx) =>
        finishSend(
          state,
          message !== undefined && sameContent(record, message)
            ? { proposalId, outcome: "accepted" }
            : {
                proposalId,
                outcome: "conflict",
                reason: message === undefined ? "message_missing" : "content_mismatch",
              },
          ctx,
        ),
      );

    /**
     * Keeps a send open with a reason. The same reason again is a refusal with no
     * state change, so a repeating 30-second pass does not republish the snapshot.
     */
    const unverified = (projectId: CreatorProjectId, proposalId: CreatorProposalId, why: string) =>
      settle(projectId, proposalId, (state) =>
        findProposal(state, proposalId)?.send?.reason === `unverified: ${why}`
          ? { ok: false, reason: "invalid" }
          : noteSendReason(state, { proposalId, reason: `unverified: ${why}` }),
      );

    const probeReceipt = (commandId: CommandId) =>
      attempt("receipt read", receipts.getByCommandId(commandId)).pipe(
        Effect.map((read): ReceiptProbe =>
          Option.match(read, {
            onNone: () => ({ _tag: "unknown" }),
            onSome: (receipt) =>
              Option.match(receipt, {
                onNone: () => ({ _tag: "none" }),
                onSome: (found) =>
                  found.status === "accepted"
                    ? { _tag: "accepted" }
                    : { _tag: "rejected", error: found.error },
              }),
          }),
        ),
      );

    const probeThread = (destination: CreatorDestination, messageId: MessageId) =>
      attempt(
        "thread read",
        threads
          .getProjectThreadRecords(
            { projectId: destination.projectId, threadId: destination.threadId },
            ["messages"],
            { messageIds: [messageId] },
          )
          .pipe(
            Effect.map((records): ThreadProbe => ({
              _tag: "found",
              archived: records.thread.archivedAt !== null,
              message: records.messages.find((message) => message.id === messageId),
            })),
            Effect.catchTags({
              ThreadManagementThreadNotFoundError: () =>
                Effect.succeed<ThreadProbe>({ _tag: "gone" }),
            }),
          ),
      ).pipe(Effect.map(Option.getOrElse((): ThreadProbe => ({ _tag: "unknown" }))));

    /** Reads the proposal's pinned shots and names one image attachment per shot. */
    const loadAttachments = (
      projectId: CreatorProjectId,
      proposal: CreatorProposal,
      messageId: MessageId,
    ) =>
      Effect.gen(function* () {
        const pinned: PinnedAttachment[] = [];
        const imageIndexes = new Map<number, number>();
        for (const [index, item] of proposal.items.entries()) {
          if (item.shot === null) continue;
          const bytes = yield* creator.readProposalShot(projectId, proposal.id, item.shot);
          const id = createDeterministicAttachmentId(
            proposal.destination.threadId,
            `${messageId}:${pinned.length}`,
          );
          if (id === null) return yield* Effect.fail(operationError("invalid", "attachment_id"));
          pinned.push({
            attachment: {
              type: "image",
              id: ChatAttachmentId.make(id),
              name: `amu-creator-${item.number}.png`,
              mimeType: "image/png",
              sizeBytes: bytes.byteLength,
            },
            bytes,
          });
          imageIndexes.set(index, pinned.length);
        }
        return { pinned, imageIndexes };
      });

    /** Same id, same bytes: writing again is harmless. */
    const writeAttachment = ({ attachment, bytes }: PinnedAttachment) => {
      const relative = attachmentRelativePath(attachment);
      if (relative === null) return Effect.fail(operationError("invalid", "attachment_type"));
      return fileSystem.writeFile(path.join(config.attachmentsDir, relative), bytes).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Amu Creator could not write an attachment", { cause }),
        ),
        Effect.mapError(() => operationError("unavailable", "write_attachment")),
      );
    };

    /** Before a resend: put the record's attachment files back in case they were removed. */
    const restoreAttachments = (
      projectId: CreatorProjectId,
      proposal: CreatorProposal,
      record: CreatorSendRecord,
    ) =>
      loadAttachments(projectId, proposal, record.messageId).pipe(
        Effect.flatMap(({ pinned }) =>
          Effect.forEach(
            pinned.filter((entry, index) => entry.attachment.id === record.attachments[index]?.id),
            writeAttachment,
            { discard: true },
          ),
        ),
        Effect.catch((error) =>
          Effect.logWarning("Amu Creator could not restore attachments before a resend", {
            error,
          }),
        ),
      );

    const messageText = (
      binding: CreatorService.CreatorBinding,
      state: CreatorStoreFile,
      proposal: CreatorProposal,
      imageIndexes: ReadonlyMap<number, number>,
    ) => {
      const commentById = new Map(state.comments.map((comment) => [comment.id, comment]));
      // The newest comment's project version stands for the current one.
      const newest = state.comments.toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
        ?.projectRevision;
      const source =
        binding.sourceKind === "mp4"
          ? (binding.sourceVideo ?? binding.servingRoot)
          : binding.servingRoot;
      return buildCreatorMessage({
        projectLabel: path.basename(source),
        sourceKind: binding.sourceKind,
        items: proposal.items.map((item, index) => {
          const revision = commentById.get(item.commentId)?.projectRevision;
          return {
            number: item.number,
            timeSec: item.timeSec,
            comment: item.comment,
            place: item.place,
            imageIndex: imageIndexes.get(index) ?? null,
            outdated: newest !== undefined && revision !== undefined && revision !== newest,
          };
        }),
      });
    };

    /**
     * Holding the proposal's lock: lands the halted send if it provably did not
     * land; settles it as sent if it did; otherwise keeps it halted with a reason.
     */
    const settleHalted = (projectId: CreatorProjectId, proposalId: CreatorProposalId) =>
      Effect.gen(function* () {
        const state = yield* readState(projectId);
        const proposal = findProposal(state, proposalId);
        const send = proposal?.send;
        if (proposal === undefined || !send || send.state !== "halted") {
          return outcomeOf(state, proposalId);
        }
        if (inFlight.has(proposalId)) return yield* unverified(projectId, proposalId, "in_flight");
        const receipt = yield* probeReceipt(send.commandId);
        if (receipt._tag === "unknown") {
          return yield* unverified(projectId, proposalId, "receipt_query_failed");
        }
        if (receipt._tag === "rejected") {
          return yield* reject(projectId, proposalId, receipt.error ?? "rejected");
        }
        const thread = yield* probeThread(proposal.destination, send.messageId);
        if (thread._tag === "unknown") {
          return yield* unverified(projectId, proposalId, "thread_query_failed");
        }
        const message = thread._tag === "found" ? thread.message : undefined;
        // A late acceptance wins over the halt.
        if (receipt._tag === "accepted" || message !== undefined) {
          return yield* settleAccepted(projectId, proposalId, send, message);
        }
        return yield* settle(projectId, proposalId, (current, ctx) =>
          releaseHalted(current, { proposalId }, ctx),
        );
      });

    /** Holding the proposal's lock: one dispatch of the pinned record, then settle what can be. */
    const dispatch = (
      projectId: CreatorProjectId,
      proposal: CreatorProposal,
      record: CreatorSendRecord,
    ) =>
      Effect.gen(function* () {
        const proposalId = proposal.id;
        // Registered first: whatever returns early below (a halt, the setting, the
        // gate) leaves an open record that the periodic pass must settle.
        openProjects.add(projectId);
        // Same readiness gate as the other WebSocket commands. While it waits, the
        // record stays `sending`; a failed startup leaves it for a later reconcile.
        const ready = yield* commandGate.pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Amu Creator send waits: commands not ready", { error }).pipe(
              Effect.as(false),
            ),
          ),
        );
        // The setting may have gone off since this send or pass was admitted.
        const allowed = ready && (yield* creatorEnabled);
        const started =
          allowed &&
          (yield* Effect.sync(() => {
            if (haltRequested(proposalId)) return false;
            inFlight.add(proposalId);
            return true;
          }));
        if (!started) return outcomeOf(yield* readState(projectId), proposalId);
        const exit = yield* ThreadMessageIntake.sendToThread({
          projectId: proposal.destination.projectId,
          threadId: proposal.destination.threadId,
          commandId: record.commandId,
          messageId: record.messageId,
          text: record.text,
          attachments: record.attachments,
          mode: "auto",
          createdBy: "user",
          creationSource: "web",
        }).pipe(
          Effect.provide(intake),
          Effect.exit,
          Effect.ensuring(Effect.sync(() => inFlight.delete(proposalId))),
        );
        if (Exit.isSuccess(exit)) {
          return yield* settleAccepted(projectId, proposalId, record, exit.value.message);
        }
        const error = Cause.findErrorOption(exit.cause);
        if (Option.isSome(error) && classifySendFailure(error.value) === "rejected") {
          return yield* reject(projectId, proposalId, error.value._tag);
        }
        yield* Effect.logWarning("Amu Creator send outcome unknown; reconcile will settle it", {
          proposalId,
          cause: exit.cause,
        });
        if (haltRequested(proposalId)) return yield* settleHalted(projectId, proposalId);
        return outcomeOf(yield* readState(projectId), proposalId);
      });

    /** Holding the proposal's lock: settle one started send from its receipt, or resend it. */
    const reconcileOne = (
      projectId: CreatorProjectId,
      proposalId: CreatorProposalId,
      resend: boolean,
    ) =>
      Effect.gen(function* () {
        const state = yield* readState(projectId);
        const proposal = findProposal(state, proposalId);
        const send = proposal?.send;
        // A conflict waits for the user; nothing is sent again automatically.
        if (proposal === undefined || !send || send.state === "conflict") return;
        if (send.state === "halted") {
          yield* settleHalted(projectId, proposalId);
          return;
        }
        const receipt = yield* probeReceipt(send.commandId);
        if (receipt._tag === "unknown") return;
        if (receipt._tag === "rejected") {
          yield* reject(projectId, proposalId, receipt.error ?? "rejected");
          return;
        }
        if (receipt._tag === "accepted") {
          const thread = yield* probeThread(proposal.destination, send.messageId);
          if (thread._tag === "unknown") return;
          yield* settleAccepted(
            projectId,
            proposalId,
            send,
            thread._tag === "found" ? thread.message : undefined,
          );
          return;
        }
        // No receipt: the command never committed. Resend the same record, if allowed.
        if (send.state !== "sending" || !resend || haltRequested(proposalId)) return;
        const thread = yield* probeThread(proposal.destination, send.messageId);
        if (thread._tag === "unknown") return;
        if (thread._tag === "gone" || thread.archived) {
          yield* reject(
            projectId,
            proposalId,
            thread._tag === "gone" ? "thread_not_found" : "thread_archived",
          );
          return;
        }
        if (thread.message !== undefined) {
          yield* settleAccepted(projectId, proposalId, send, thread.message);
          return;
        }
        // Counted under the project lock, with the setting, a halt and the pause
        // since the last attempt checked at that moment.
        const counted = yield* creator.withProjectState(projectId, (current, ctx) =>
          creatorEnabled.pipe(
            Effect.map((enabled) => {
              const last = Date.parse(findProposal(current, proposalId)?.send?.attemptedAt ?? "");
              const due = !(ctx.now.getTime() - last < RESEND_PAUSE_MS);
              const result: StateResult<CreatorProposal> =
                enabled && due && !haltRequested(proposalId)
                  ? markAttempt(current, { proposalId }, ctx)
                  : { ok: false, reason: "not_sending" };
              return { next: result.ok ? result.state : null, value: result };
            }),
          ),
        );
        if (!counted.ok) return;
        yield* restoreAttachments(projectId, counted.value, send);
        yield* dispatch(projectId, counted.value, send);
      });

    const creatorEnabled = settings.getSettings.pipe(
      Effect.map((current) => current.amuCreatorEnabled),
      Effect.orElseSucceed(() => false),
    );

    const logFailure = (message: string, details: Record<string, unknown>) =>
      Effect.catchCause((cause: Cause.Cause<unknown>) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(message, { ...details, cause }),
      );

    const reconcile: CreatorSender["Service"]["reconcile"] = (projectId) =>
      Effect.gen(function* () {
        const resend = yield* creatorEnabled;
        const state = yield* readState(projectId);
        for (const proposal of state.proposals) {
          if (proposal.send === null) continue;
          // A busy proposal is being handled by its holder right now.
          yield* lockOf(proposal.id)
            .withPermitsIfAvailable(1)(reconcileOne(projectId, proposal.id, resend))
            .pipe(
              logFailure("Amu Creator could not reconcile a send", {
                projectId,
                proposalId: proposal.id,
              }),
            );
        }
        const after = yield* readState(projectId);
        if (
          after.proposals.some((proposal) => proposal.send && proposal.send.state !== "conflict")
        ) {
          openProjects.add(projectId);
        } else {
          openProjects.delete(projectId);
        }
      }).pipe(logFailure("Amu Creator reconcile failed", { projectId }));

    const reconcileOpen: CreatorSender["Service"]["reconcileOpen"] = Effect.suspend(() =>
      Effect.forEach([...openProjects], reconcile, { discard: true }),
    );

    const storedProjects = fileSystem
      .readDirectory(path.join(config.stateDir, "creator", "projects"))
      .pipe(
        Effect.map((names) =>
          names.filter((name) => PROJECT_DIR.test(name)).map((name) => name as CreatorProjectId),
        ),
        Effect.orElseSucceed((): CreatorProjectId[] => []),
      );

    /** The caller must hold a live binding at the current epoch with a live generation. */
    const authorize = (input: { readonly bindingId: CreatorBindingId; readonly epoch: number }) =>
      creator
        .requireBinding(input.bindingId)
        .pipe(
          Effect.flatMap((binding) =>
            binding.generation === null || binding.epoch !== input.epoch
              ? Effect.fail(operationError("stale_epoch", "stale_epoch"))
              : Effect.succeed(binding),
          ),
        );

    const confirmSend: CreatorSender["Service"]["confirmSend"] = Effect.fn(
      "CreatorSender.confirmSend",
    )(function* (input) {
      // Authority (binding, epoch, generation, proposal owner) is decided once, at
      // admission: a revoke that lands after this does not cancel an approved send
      // (plan H). The setting is checked again right before the dispatch.
      const binding = yield* authorize(input);
      const projectId = binding.projectId;
      const admitted = findProposal(yield* readState(projectId), input.proposalId);
      if (admitted === undefined) {
        return yield* Effect.fail(operationError("not_found", "proposal"));
      }
      if (admitted.bindingId !== binding.bindingId) {
        return yield* Effect.fail(operationError("unauthorized", "other_binding"));
      }
      yield* reconcile(projectId);
      return yield* lockOf(input.proposalId).withPermits(1)(
        Effect.gen(function* () {
          const state = yield* readState(projectId);
          const proposal = findProposal(state, input.proposalId);
          if (proposal === undefined) {
            return yield* Effect.fail(operationError("not_found", "proposal"));
          }
          if (proposal.send !== null) {
            return yield* Effect.fail(operationError("conflict", "already_sending"));
          }
          const proposalId = proposal.id;
          const messageId = MessageId.make(`creator:${proposalId}`);
          const { pinned, imageIndexes } = yield* loadAttachments(projectId, proposal, messageId);
          const now = yield* DateTime.now;
          const record: CreatorSendRecord = {
            commandId: CommandId.make(`creator:${proposalId}`),
            messageId,
            text: messageText(binding, state, proposal, imageIndexes),
            attachments: pinned.map((entry) => entry.attachment),
            state: "sending",
            reason: null,
            attemptedAt: DateTime.formatIso(now),
            attempts: 0,
            haltRequested: false,
          };
          const begin = (current: CreatorStoreFile, ctx: CreatorStateContext) =>
            beginSend(current, { proposalId, revisionKey: input.revisionKey, record }, ctx);

          const thread = yield* probeThread(proposal.destination, messageId);
          if (thread._tag === "unknown") {
            return yield* Effect.fail(operationError("unavailable", "thread_unreadable"));
          }
          if (thread._tag === "gone" || thread.archived) {
            const reason = thread._tag === "gone" ? "thread_not_found" : "thread_archived";
            yield* applyOrFail(projectId, (current, ctx) => {
              const started = begin(current, ctx);
              return started.ok
                ? finishSend(started.state, { proposalId, outcome: "rejected", reason }, ctx)
                : started;
            });
            return { proposalId, state: "rejected", reason } satisfies CreatorSendResult;
          }
          yield* Effect.forEach(pinned, writeAttachment, { discard: true });
          const started = yield* applyOrFail(projectId, begin);
          return yield* dispatch(projectId, started, record);
        }),
      );
    });

    const haltSend: CreatorSender["Service"]["haltSend"] = Effect.fn("CreatorSender.haltSend")(
      function* (input) {
        // Any live binding of the project may stop a send; stopping never sends anything.
        const binding = yield* authorize(input);
        const projectId = binding.projectId;
        const state = yield* readState(projectId);
        const proposal = findProposal(state, input.proposalId);
        if (proposal === undefined) {
          return state.history.some((entry) => entry.id === input.proposalId)
            ? outcomeOf(state, input.proposalId)
            : yield* Effect.fail(operationError("not_found", "proposal"));
        }
        if (proposal.send === null) {
          return yield* Effect.fail(operationError("conflict", "not_sending"));
        }
        if (proposal.send.state === "conflict") {
          return yield* Effect.fail(operationError("conflict", "conflict"));
        }
        // Stop resends first (no lock needed), then record the request.
        yield* Deferred.succeed(haltSignal(proposal.id), undefined);
        yield* applyOrFail(projectId, (current) =>
          requestHalt(current, { proposalId: proposal.id }),
        );
        // Settle now only if nothing holds the proposal; a holder settles it when its send ends.
        const settled = yield* lockOf(proposal.id).withPermitsIfAvailable(1)(
          settleHalted(projectId, proposal.id),
        );
        return Option.isSome(settled)
          ? settled.value
          : outcomeOf(yield* readState(projectId), proposal.id);
      },
    );

    const acknowledgeConflict: CreatorSender["Service"]["acknowledgeConflict"] = Effect.fn(
      "CreatorSender.acknowledgeConflict",
    )(function* (input) {
      // No owner check, like haltSend: the message already went out (or not) under
      // the proposal's own binding, and acknowledging sends nothing. It only
      // releases the user's comments, so any live binding of the same project
      // (the same source and thread, after a reopen) may settle it.
      const binding = yield* authorize(input);
      const projectId = binding.projectId;
      return yield* lockOf(input.proposalId).withPermits(1)(
        Effect.gen(function* () {
          const state = yield* readState(projectId);
          if (
            findProposal(state, input.proposalId) === undefined &&
            state.history.some((entry) => entry.id === input.proposalId)
          ) {
            return outcomeOf(state, input.proposalId);
          }
          yield* applyOrFail(projectId, (current, ctx) =>
            acknowledgeConflictState(current, { proposalId: input.proposalId }, ctx),
          );
          return outcomeOf(yield* readState(projectId), input.proposalId);
        }),
      );
    });

    const reconcileInBackground: CreatorSender["Service"]["reconcileInBackground"] = (bindingId) =>
      creator.requireBinding(bindingId).pipe(
        Effect.flatMap((binding) => reconcile(binding.projectId).pipe(Effect.forkIn(scope))),
        Effect.asVoid,
        Effect.ignore,
      );

    const startup = yield* Deferred.make<void>();
    yield* commandGate.pipe(
      Effect.andThen(storedProjects),
      Effect.flatMap((projectIds) => Effect.forEach(projectIds, reconcile, { discard: true })),
      logFailure("Amu Creator startup reconcile failed", {}),
      Effect.ensuring(Deferred.succeed(startup, undefined)),
      Effect.forkIn(scope),
    );
    if (pollInterval !== null) {
      yield* Effect.sleep(pollInterval).pipe(
        Effect.andThen(reconcileOpen),
        Effect.forever,
        Effect.forkIn(scope),
      );
    }

    return CreatorSender.of({
      confirmSend,
      haltSend,
      acknowledgeConflict,
      reconcile,
      reconcileOpen,
      reconcileInBackground,
      startupDone: Deferred.await(startup),
    });
  });

/** Waits for the orchestrator to accept commands before the startup reconcile. */
export const layer = Layer.effect(
  CreatorSender,
  Effect.gen(function* () {
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    return yield* make({
      commandGate: startup.awaitCommandReady,
      pollInterval: POLL_INTERVAL,
    });
  }),
).pipe(Layer.provide(CommandReceiptStore.layerFromApplicationReceipts));

/** For tests: the given readiness gate, no periodic pass, receipts from the context. */
export const layerTest = (
  commandGate: Effect.Effect<void, ServerRuntimeStartup.ServerRuntimeStartupError>,
) => Layer.effect(CreatorSender, make({ commandGate, pollInterval: null }));
