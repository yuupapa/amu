import {
  OrchestrationGetHandoffPacketError,
  type OrchestrationGetHandoffPacketInput,
  type OrchestrationGetHandoffPacketResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionThreadProviderSwitchRepositoryShape } from "../persistence/Services/ProjectionThreadProviderSwitches.ts";

/**
 * The full packet text for clients (P11): live events carry it empty. A
 * packet of another thread reads as not found, so a client can only read the
 * packets of threads it can already read.
 */
export const readHandoffPacket = (
  switches: Pick<ProjectionThreadProviderSwitchRepositoryShape, "getPacket">,
  input: OrchestrationGetHandoffPacketInput,
): Effect.Effect<OrchestrationGetHandoffPacketResult, OrchestrationGetHandoffPacketError> =>
  switches.getPacket({ packetId: input.packetId }).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationGetHandoffPacketError({
          message: "Failed to load the handoff packet.",
          cause,
        }),
    ),
    Effect.flatMap((packet) => {
      if (Option.isNone(packet) || packet.value.threadId !== input.threadId) {
        return Effect.fail(
          new OrchestrationGetHandoffPacketError({ message: "The handoff packet was not found." }),
        );
      }
      const { packetId, text, chars, includedMessages, omittedMessages, truncated, createdAt } =
        packet.value;
      return Effect.succeed({
        packetId,
        text,
        chars,
        includedMessages,
        omittedMessages,
        truncated,
        createdAt,
      });
    }),
  );
