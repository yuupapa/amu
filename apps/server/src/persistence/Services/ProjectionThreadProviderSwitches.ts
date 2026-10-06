/**
 * ProjectionThreadProviderSwitchRepository - persisted cross-provider switch
 * state and handoff packets (design §5.2).
 *
 * @module ProjectionThreadProviderSwitchRepository
 */
import {
  IsoDateTime,
  MessageDeliveryState,
  MessageId,
  NonNegativeInt,
  OrchestrationThreadProviderSwitchState,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSwitchId,
  ProviderSwitchPacketId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadProviderSwitchStateRow = Schema.Struct({
  threadId: ThreadId,
  state: OrchestrationThreadProviderSwitchState,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadProviderSwitchStateRow =
  typeof ProjectionThreadProviderSwitchStateRow.Type;

export const ProjectionThreadHandoffPacket = Schema.Struct({
  packetId: ProviderSwitchPacketId,
  threadId: ThreadId,
  switchId: ProviderSwitchId,
  text: Schema.String,
  sha256: TrimmedNonEmptyString,
  chars: NonNegativeInt,
  includedMessages: NonNegativeInt,
  omittedMessages: NonNegativeInt,
  truncated: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type ProjectionThreadHandoffPacket = typeof ProjectionThreadHandoffPacket.Type;

export const ProjectionThreadIdInput = Schema.Struct({ threadId: ThreadId });
export type ProjectionThreadIdInput = typeof ProjectionThreadIdInput.Type;

export const GetProjectionThreadHandoffPacketInput = Schema.Struct({
  packetId: ProviderSwitchPacketId,
});
export type GetProjectionThreadHandoffPacketInput =
  typeof GetProjectionThreadHandoffPacketInput.Type;

export const SetProjectionMessageDeliveryStateInput = Schema.Struct({
  messageId: MessageId,
  deliveryState: MessageDeliveryState,
});
export type SetProjectionMessageDeliveryStateInput =
  typeof SetProjectionMessageDeliveryStateInput.Type;

export const ProjectionTurnAssignment = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  messageId: MessageId,
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  generation: Schema.NullOr(NonNegativeInt),
  /** A later record for the same turn named a different instance or model. */
  changedMidTurn: Schema.Boolean,
  recordedAt: IsoDateTime,
});
export type ProjectionTurnAssignment = typeof ProjectionTurnAssignment.Type;

/** Read limits for the handoff source (design §6.4, §15 P10). */
export const HANDOFF_SOURCE_LIMITS = {
  userMessages: 200,
  userChars: 200_000,
  userMessageChars: 6_000,
  logTurns: 50,
  logEntries: 200,
  logChars: 100_000,
  logEntryChars: 2_000,
  planChars: 6_000,
  contextLabels: 20,
} as const;

export const ReadHandoffSourceInput = Schema.Struct({
  threadId: ThreadId,
  /** The message being sent now; it goes into [[AMU-NOW]], not the history. */
  triggerMessageId: MessageId,
});
export type ReadHandoffSourceInput = typeof ReadHandoffSourceInput.Type;

export interface HandoffSourceUserRow {
  readonly messageId: MessageId;
  readonly turn: number | null;
  /** At most HANDOFF_SOURCE_LIMITS.userMessageChars characters. */
  readonly text: string;
  readonly fullChars: number;
  readonly contextLabels: ReadonlyArray<string>;
}

export interface HandoffSourceLogRow {
  readonly kind: "assistant" | "tool";
  readonly turn: number | null;
  readonly model: string | null;
  /** At most HANDOFF_SOURCE_LIMITS.logEntryChars characters. */
  readonly text: string;
  readonly fullChars: number;
}

/** Bounded raw material for one handoff packet; never reads activity payloads. */
export interface HandoffSourceRows {
  readonly thread: {
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly runtimeMode: string;
    readonly interactionMode: string;
  } | null;
  readonly firstUser: HandoffSourceUserRow | null;
  /** Oldest first; the newest messages that fit the limits. */
  readonly users: ReadonlyArray<HandoffSourceUserRow>;
  readonly omittedUsers: number;
  readonly plan: {
    readonly markdown: string;
    readonly fullChars: number;
    readonly implemented: boolean;
  } | null;
  readonly lastTurnState: string | null;
  readonly lastError: string | null;
  /** Oldest first; the newest entries of the last turns that fit the limits. */
  readonly log: ReadonlyArray<HandoffSourceLogRow>;
  readonly omittedAssistantMessages: number;
  readonly omittedToolEntries: number;
}

export interface ProjectionThreadProviderSwitchRepositoryShape {
  readonly getStateByThreadId: (
    input: ProjectionThreadIdInput,
  ) => Effect.Effect<
    Option.Option<ProjectionThreadProviderSwitchStateRow>,
    ProjectionRepositoryError
  >;
  /** Every thread's state; used to rebuild the command read model at startup. */
  readonly listStates: () => Effect.Effect<
    ReadonlyArray<ProjectionThreadProviderSwitchStateRow>,
    ProjectionRepositoryError
  >;
  readonly upsertState: (
    row: ProjectionThreadProviderSwitchStateRow,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /**
   * Packets are immutable: re-inserting an identical packet is a no-op; a
   * different packet under a used id fails.
   */
  readonly insertPacket: (
    row: ProjectionThreadHandoffPacket,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly getPacket: (
    input: GetProjectionThreadHandoffPacketInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadHandoffPacket>, ProjectionRepositoryError>;
  /**
   * The first record for a turn wins (steering reuses the turn id); a later
   * record with a different instance or model only sets changedMidTurn.
   */
  readonly recordTurnAssignment: (
    row: Omit<ProjectionTurnAssignment, "changedMidTurn">,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listTurnAssignments: (
    input: ProjectionThreadIdInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionTurnAssignment>, ProjectionRepositoryError>;
  /** Drops the thread's state, packets and turn assignments (a re-created thread id starts clean). */
  readonly deleteByThreadId: (
    input: ProjectionThreadIdInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /**
   * Bounded read for a handoff packet: only delivered user messages, never
   * the trigger, text cut in SQL, omitted counts from COUNT (design §6.4).
   */
  readonly readHandoffSource: (
    input: ReadHandoffSourceInput,
  ) => Effect.Effect<HandoffSourceRows, ProjectionRepositoryError>;
  /** Whether a delivered user message (NULL counts as delivered) other than `excludeMessageId` exists. */
  readonly hasDeliveredUserMessage: (input: {
    readonly threadId: ThreadId;
    readonly excludeMessageId: MessageId;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
  /** The stored delivery state; null means delivered from before the feature (or unknown message). */
  readonly getMessageDeliveryState: (input: {
    readonly messageId: MessageId;
  }) => Effect.Effect<MessageDeliveryState | null, ProjectionRepositoryError>;
  /** Highest checkpoint turn count of the thread, 0 when none: a switch's boundary S (§7.4). */
  readonly getLatestCheckpointTurnCount: (
    input: ProjectionThreadIdInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
  /** Writes projection_thread_messages.delivery_state; NULL there means delivered. */
  readonly setMessageDeliveryState: (
    input: SetProjectionMessageDeliveryStateInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadProviderSwitchRepository extends Context.Service<
  ProjectionThreadProviderSwitchRepository,
  ProjectionThreadProviderSwitchRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadProviderSwitches/ProjectionThreadProviderSwitchRepository",
) {}
