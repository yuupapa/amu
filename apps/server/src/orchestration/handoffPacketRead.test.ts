import {
  ProviderSwitchId,
  ProviderSwitchPacketId,
  ThreadId,
  type OrchestrationGetHandoffPacketError,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import type { ProjectionThreadHandoffPacket } from "../persistence/Services/ProjectionThreadProviderSwitches.ts";
import { readHandoffPacket } from "./handoffPacketRead.ts";

const threadId = ThreadId.make("thread-packet");
const packetId = ProviderSwitchPacketId.make("packet-1");
const stored: ProjectionThreadHandoffPacket = {
  packetId,
  threadId,
  switchId: ProviderSwitchId.make("switch-1"),
  text: "[[AMU-HANDOFF v1]] the whole conversation",
  sha256: "abc",
  chars: 40,
  includedMessages: 2,
  omittedMessages: 1,
  truncated: true,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const repository = (packet: ProjectionThreadHandoffPacket | null) => ({
  getPacket: () => Effect.succeed(Option.fromNullishOr(packet)),
});

describe("readHandoffPacket", () => {
  it.effect("returns the stored text and counts", () =>
    Effect.gen(function* () {
      const result = yield* readHandoffPacket(repository(stored), { threadId, packetId });
      assert.deepEqual(result, {
        packetId,
        text: stored.text,
        chars: 40,
        includedMessages: 2,
        omittedMessages: 1,
        truncated: true,
        createdAt: stored.createdAt,
      });
    }),
  );

  it.effect("does not return another thread's packet", () =>
    Effect.gen(function* () {
      const error: OrchestrationGetHandoffPacketError = yield* readHandoffPacket(
        repository(stored),
        { threadId: ThreadId.make("thread-other"), packetId },
      ).pipe(Effect.flip);
      assert.equal(error.message, "The handoff packet was not found.");
      const missing = yield* readHandoffPacket(repository(null), { threadId, packetId }).pipe(
        Effect.flip,
      );
      assert.equal(missing.message, "The handoff packet was not found.");
    }),
  );

  it.effect("reports a failed read", () =>
    Effect.gen(function* () {
      const failing = {
        getPacket: () =>
          Effect.fail(new PersistenceSqlError({ operation: "getPacket", detail: "disk error" })),
      };
      const error = yield* readHandoffPacket(failing, { threadId, packetId }).pipe(Effect.flip);
      assert.equal(error.message, "Failed to load the handoff packet.");
    }),
  );
});
