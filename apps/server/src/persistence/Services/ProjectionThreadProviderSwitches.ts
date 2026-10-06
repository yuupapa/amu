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
  ProviderSwitchId,
  ProviderSwitchPacketId,
  ThreadId,
  TrimmedNonEmptyString,
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
  /** Drops the thread's state and packets (a re-created thread id starts clean). */
  readonly deleteByThreadId: (
    input: ProjectionThreadIdInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
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
