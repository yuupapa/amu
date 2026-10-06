import {
  EMPTY_THREAD_PROVIDER_SWITCH_STATE,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type OrchestrationTurnAssignment,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyProviderSwitchEvent,
  applyTurnAssignmentRecord,
  mergeTurnAssignmentPages,
  type ProviderSwitchEvent,
} from "./providerSwitchFold.ts";

const row = (turn: string, model: string, changedMidTurn = false): OrchestrationTurnAssignment => ({
  turnId: TurnId.make(turn),
  messageId: MessageId.make(`message-${turn}`),
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  model,
  generation: 1,
  changedMidTurn,
});

describe("applyTurnAssignmentRecord", () => {
  it("keeps the first record and flags a different later one", () => {
    const first = applyTurnAssignmentRecord([], row("turn-1", "model-a"));
    expect(first).toEqual([row("turn-1", "model-a")]);
    expect(applyTurnAssignmentRecord(first, row("turn-1", "model-a"))).toBe(first);
    expect(applyTurnAssignmentRecord(first, row("turn-1", "model-b"))).toEqual([
      row("turn-1", "model-a", true),
    ]);
  });
});

describe("mergeTurnAssignmentPages", () => {
  it("puts the older page first and keeps loaded rows of other turns", () => {
    expect(
      mergeTurnAssignmentPages([row("turn-1", "model-a")], [row("turn-2", "model-b")]),
    ).toEqual([row("turn-1", "model-a"), row("turn-2", "model-b")]);
  });

  it("lets the page's settled record win and keeps any change it missed", () => {
    expect(
      mergeTurnAssignmentPages([row("turn-1", "model-a")], [row("turn-1", "model-b")]),
    ).toEqual([row("turn-1", "model-a", true)]);
    expect(
      mergeTurnAssignmentPages([row("turn-1", "model-a")], [row("turn-1", "model-a")]),
    ).toEqual([row("turn-1", "model-a")]);
    expect(
      mergeTurnAssignmentPages([row("turn-1", "model-a", true)], [row("turn-1", "model-a")]),
    ).toEqual([row("turn-1", "model-a", true)]);
  });
});

describe("applyProviderSwitchEvent: what the user is shown", () => {
  const event = (type: string, payload: Record<string, unknown>) =>
    ({
      type,
      payload: {
        threadId: "thread-1",
        createdAt: "2026-10-06T00:00:00.000Z",
        switchId: "switch-1",
        ...payload,
      },
    }) as unknown as ProviderSwitchEvent;
  const codex = { instanceId: "codex", driver: "codex", model: "gpt-6.1-sol" };
  const claude = { instanceId: "claudeAgent", driver: "claudeAgent", model: "claude-opus-5-5" };

  it("keeps why the switch waits until the user retries", () => {
    const requested = applyProviderSwitchEvent(
      EMPTY_THREAD_PROVIDER_SWITCH_STATE,
      event("thread.provider-switch-requested", {
        from: codex,
        to: claude,
        triggerMessageId: "message-1",
        boundaryTurnCount: 2,
      }),
    );
    const waiting = applyProviderSwitchEvent(
      requested,
      event("thread.provider-switch-awaiting-user", {
        attemptId: 0,
        resumeCount: 0,
        reason: "failed-retryable",
        detail: "start failed",
      }),
    );
    expect(waiting.pending?.awaitingDetail).toBe("start failed");
    const retried = applyProviderSwitchEvent(
      waiting,
      event("thread.provider-switch-retry-requested", {}),
    );
    expect(retried.pending?.status).toBe("in-progress");
    expect(retried.pending?.awaitingDetail).toBeNull();
  });
});
