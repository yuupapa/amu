import {
  EMPTY_THREAD_PROVIDER_SWITCH_STATE,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSwitchId,
  TurnId,
  type OrchestrationPendingProviderSwitch,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  answeringModelLabel,
  canOfferHandoffTo,
  conversationOwner,
  handoffDividers,
  handoffLockReason,
  makeLatestRequestGate,
  predictsHandoff,
  switchBannerModel,
  switchContinuationHints,
  switchRevertBlock,
  userMessageDeliveryLabel,
  visibleSessionError,
  type SwitchProvider,
} from "./providerSwitchView";

const codexId = ProviderInstanceId.make("codex");
const claudeId = ProviderInstanceId.make("claudeAgent");
const model = (slug: string, name: string) => ({
  slug,
  name,
  isCustom: false,
  capabilities: null,
});
const providers: ReadonlyArray<SwitchProvider> = [
  {
    instanceId: codexId,
    driver: ProviderDriverKind.make("codex"),
    displayName: "Codex",
    models: [model("gpt-6.1-sol", "GPT-6.1 Sol")],
  },
  {
    instanceId: claudeId,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    models: [model("claude-opus-5-5", "Claude Opus 5.5")],
    requiresNewThreadForModelChange: true,
  },
];
const codex = {
  instanceId: codexId,
  driver: ProviderDriverKind.make("codex"),
  model: "gpt-6.1-sol",
};
const claude = {
  instanceId: claudeId,
  driver: ProviderDriverKind.make("claudeAgent"),
  model: "claude-opus-5-5",
};

const baseThread = {
  modelSelection: { instanceId: codexId, model: "gpt-6.1-sol" },
  session: null,
  messages: [],
  latestTurn: null,
} as unknown as Pick<
  OrchestrationThread,
  "providerSwitch" | "turnAssignments" | "session" | "modelSelection" | "messages" | "latestTurn"
>;

const pending = (
  patch: Partial<OrchestrationPendingProviderSwitch>,
): OrchestrationThread["providerSwitch"] => ({
  ...EMPTY_THREAD_PROVIDER_SWITCH_STATE,
  hasHistory: true,
  pending: {
    switchId: ProviderSwitchId.make("switch-1"),
    from: codex,
    to: claude,
    triggerMessageId: MessageId.make("message-1"),
    boundaryTurnCount: 2,
    status: "in-progress",
    awaitingReason: null,
    milestone: "requested",
    packet: null,
    attempts: [],
    deliveryUncertain: false,
    resendAllowed: false,
    resumeCount: 0,
    requestedAt: "2026-10-06T00:00:00.000Z",
    ...patch,
  },
});

describe("conversationOwner", () => {
  it("is nobody before the first turn, then the session or last answerer", () => {
    expect(conversationOwner(baseThread)).toBeNull();
    expect(
      conversationOwner({
        ...baseThread,
        session: { providerInstanceId: codexId } as OrchestrationThread["session"],
      }),
    ).toEqual({ instanceId: codexId, model: "gpt-6.1-sol" });
    expect(
      conversationOwner({
        ...baseThread,
        turnAssignments: [
          {
            turnId: TurnId.make("turn-1"),
            messageId: MessageId.make("message-1"),
            ...claude,
            generation: 2,
            changedMidTurn: false,
          },
        ],
      }),
    ).toEqual({ instanceId: claudeId, model: "claude-opus-5-5" });
  });
});

describe("conversationOwner after /compact", () => {
  it("keeps the recorded answerer when the thread's selection names the next pick", () => {
    // /compact saved Sonnet as the selection but compacted on Opus (§9.3).
    const thread = {
      ...baseThread,
      modelSelection: { instanceId: claudeId, model: "claude-sonnet-5-5" },
      session: { providerInstanceId: claudeId } as OrchestrationThread["session"],
      turnAssignments: [
        {
          turnId: TurnId.make("turn-1"),
          messageId: MessageId.make("message-1"),
          ...claude,
          generation: 1,
          changedMidTurn: false,
        },
      ],
    };
    const owner = conversationOwner(thread);
    expect(owner).toEqual({ instanceId: claudeId, model: "claude-opus-5-5" });
    // Claude needs a new thread for a model change: the next send hands over.
    expect(
      predictsHandoff(owner, { instanceId: claudeId, model: "claude-sonnet-5-5" }, providers),
    ).toBe(true);
  });
});

describe("conversationOwner with a late record", () => {
  const record = (turn: string, party: typeof claude, generation: number) => ({
    turnId: TurnId.make(turn),
    messageId: MessageId.make(`message-${turn}`),
    ...party,
    generation,
    changedMidTurn: false,
  });
  it("is not pulled back by an older turn's record saved after a newer one", () => {
    // Claude answered turn-2 (generation 2); Codex's turn-1 record (generation 1)
    // was retried and landed after it, last in the array.
    const assignments = [record("turn-2", claude, 2), record("turn-1", codex, 1)];
    expect(
      conversationOwner({
        ...baseThread,
        latestTurn: { turnId: TurnId.make("turn-2") } as OrchestrationThread["latestTurn"],
        turnAssignments: assignments,
      }),
    ).toEqual({ instanceId: claudeId, model: "claude-opus-5-5" });
    // Without the latest turn's record, the newest generation still wins.
    expect(
      conversationOwner({
        ...baseThread,
        latestTurn: { turnId: TurnId.make("turn-3") } as OrchestrationThread["latestTurn"],
        turnAssignments: assignments,
      }),
    ).toEqual({ instanceId: claudeId, model: "claude-opus-5-5" });
  });
});

describe("predictsHandoff", () => {
  it("hands over across drivers and for a new-thread-only model change", () => {
    expect(predictsHandoff(null, codex, providers)).toBe(false);
    expect(predictsHandoff(codex, claude, providers)).toBe(true);
    expect(predictsHandoff(codex, codex, providers)).toBe(false);
    expect(predictsHandoff(claude, { ...claude, model: "claude-sonnet-5-5" }, providers)).toBe(
      true,
    );
  });
});

describe("switchContinuationHints", () => {
  it("hands over after a closed switch that stopped the old session, or to an unconfirmed session", () => {
    const closed = {
      ...EMPTY_THREAD_PROVIDER_SWITCH_STATE,
      hasHistory: true,
      resolvedSwitchIds: [ProviderSwitchId.make("switch-1")],
      lastClosed: {
        switchId: ProviderSwitchId.make("switch-1"),
        from: codex,
        to: claude,
        reason: "aborted" as const,
        oldStopped: true,
      },
    };
    const released = switchContinuationHints({ providerSwitch: closed });
    expect(released).toEqual({ released: true, unconfirmedInstanceId: null });
    // Even back to the same model: its cursor is gone.
    expect(predictsHandoff(codex, codex, providers, released)).toBe(true);
    // A later delivered switch is the last resolved one: nothing released.
    expect(
      switchContinuationHints({
        providerSwitch: {
          ...closed,
          resolvedSwitchIds: [ProviderSwitchId.make("switch-1"), ProviderSwitchId.make("switch-2")],
        },
      }).released,
    ).toBe(false);
    const discarded = switchContinuationHints({
      providerSwitch: {
        ...EMPTY_THREAD_PROVIDER_SWITCH_STATE,
        hasHistory: true,
        handoffUnconfirmedInstanceId: claudeId,
      },
    });
    expect(predictsHandoff(claude, claude, providers, discarded)).toBe(true);
    expect(predictsHandoff(codex, codex, providers, discarded)).toBe(false);
  });
});

describe("userMessageDeliveryLabel", () => {
  it("labels messages that did not simply go out", () => {
    expect(userMessageDeliveryLabel(undefined)).toBeNull();
    expect(userMessageDeliveryLabel("delivered")).toBeNull();
    expect(userMessageDeliveryLabel("pending")).toBeNull();
    expect(userMessageDeliveryLabel("cancelled")).toBe("未送信・取消");
    expect(userMessageDeliveryLabel("unknown-discarded")).toBe("届いたか不明・再送なし");
    expect(userMessageDeliveryLabel("rejected")).toBe("未送信");
  });
});

describe("canOfferHandoffTo", () => {
  const settings = { enabled: true, allowedDrivers: ["claudeAgent", "codex", "cursor"] } as never;
  const input = {
    settings,
    ownerDriver: "codex",
    targetDriver: "claudeAgent",
    threadBusy: false,
    switchPending: false,
  };
  it("offers an allowed, generation-stamping driver while idle", () => {
    expect(canOfferHandoffTo(input)).toBe(true);
  });
  it("refuses while busy, switching, off, or for a driver without generations", () => {
    expect(canOfferHandoffTo({ ...input, threadBusy: true })).toBe(false);
    expect(canOfferHandoffTo({ ...input, switchPending: true })).toBe(false);
    expect(canOfferHandoffTo({ ...input, targetDriver: "cursor" })).toBe(false);
    expect(
      canOfferHandoffTo({ ...input, settings: { enabled: false, allowedDrivers: [] } as never }),
    ).toBe(false);
  });
});

describe("handoffLockReason", () => {
  const idle = { enabled: true, threadBusy: false, waitsOnUser: false, switchPending: false };

  it("says why a switch must wait, most specific first", () => {
    expect(handoffLockReason(idle)).toBeNull();
    expect(handoffLockReason({ ...idle, threadBusy: true })).toContain("応答中");
    expect(handoffLockReason({ ...idle, threadBusy: true, waitsOnUser: true })).toContain("返答");
    expect(
      handoffLockReason({ ...idle, threadBusy: true, waitsOnUser: true, switchPending: true }),
    ).toContain("乗り換え中");
  });

  it("leaves the old lock message when the feature is off", () => {
    expect(handoffLockReason({ ...idle, enabled: false, threadBusy: true })).toBeNull();
  });
});

describe("visibleSessionError", () => {
  it("hides the copy written for older clients and keeps other errors", () => {
    expect(
      visibleSessionError("claude is not signed in（選択肢は Amu の最新版で表示されます）"),
    ).toBeNull();
    expect(visibleSessionError("Turn failed")).toBe("Turn failed");
    expect(visibleSessionError(null)).toBeNull();
    expect(visibleSessionError(undefined)).toBeNull();
  });
});

describe("switchBannerModel", () => {
  it("describes each unresolved state", () => {
    expect(switchBannerModel({ providerSwitch: undefined }, providers)).toBeNull();
    expect(switchBannerModel({ providerSwitch: pending({}) }, providers)).toEqual({
      kind: "in-progress",
      toLabel: "Claude Opus 5.5",
    });
    expect(
      switchBannerModel(
        {
          providerSwitch: pending({
            status: "awaiting-user",
            awaitingReason: "failed-retryable",
            awaitingDetail: "start failed",
          }),
        },
        providers,
      ),
    ).toEqual({
      kind: "failed-retryable",
      switchId: "switch-1",
      from: { instanceId: codexId, model: "gpt-6.1-sol" },
      fromLabel: "GPT-6.1 Sol",
      toLabel: "Claude Opus 5.5",
      detail: "start failed",
    });
    expect(
      switchBannerModel(
        {
          providerSwitch: pending({ status: "awaiting-user", awaitingReason: "unknown-delivery" }),
        },
        providers,
      ),
    ).toMatchObject({ kind: "unknown-delivery", toLabel: "Claude Opus 5.5", detail: null });
    expect(
      switchBannerModel(
        { providerSwitch: pending({ status: "closing", closing: { returnToPrevious: true } }) },
        providers,
      ),
    ).toEqual({ kind: "closing", returnToPrevious: true });
  });
});

describe("switchRevertBlock", () => {
  it("refuses during a switch and to or before the boundary", () => {
    expect(switchRevertBlock({ providerSwitch: undefined }, 1)).toBeNull();
    expect(switchRevertBlock({ providerSwitch: pending({}) }, 5)).toBe(
      "モデルの乗り換え中は戻せません。",
    );
    const delivered = {
      ...EMPTY_THREAD_PROVIDER_SWITCH_STATE,
      hasHistory: true,
      lastDelivered: {
        switchId: ProviderSwitchId.make("switch-1"),
        attemptId: 2,
        turnId: TurnId.make("turn-3"),
        boundaryTurnCount: 2,
      },
    };
    expect(switchRevertBlock({ providerSwitch: delivered }, 2)).toBe(
      "この操作は、モデルを乗り換えた所より前には戻せません。",
    );
    expect(switchRevertBlock({ providerSwitch: delivered }, 3)).toBeNull();
  });
});

describe("handoffDividers and answeringModelLabel", () => {
  const delivered = {
    ...EMPTY_THREAD_PROVIDER_SWITCH_STATE,
    hasHistory: true,
    deliveries: [
      {
        switchId: ProviderSwitchId.make("switch-1"),
        attemptId: 2,
        turnId: TurnId.make("turn-3"),
        boundaryTurnCount: 2,
        triggerMessageId: MessageId.make("message-switch"),
        from: codex,
        to: claude,
        packetId: "packet-1",
      },
    ],
  } as unknown as OrchestrationThread["providerSwitch"];

  it("puts one divider above each delivered switch's message", () => {
    const dividers = handoffDividers({ providerSwitch: delivered }, providers);
    expect([...dividers.entries()]).toEqual([
      [
        "message-switch",
        { label: "Claude Opus 5.5", providerLabel: "Claude", packetId: "packet-1" },
      ],
    ]);
  });

  it("names the answerer only on switched threads", () => {
    const assignments = [
      {
        turnId: TurnId.make("turn-3"),
        messageId: MessageId.make("message-switch"),
        ...claude,
        generation: 2,
        changedMidTurn: false,
      },
    ];
    expect(
      answeringModelLabel(
        { providerSwitch: undefined, turnAssignments: assignments },
        TurnId.make("turn-3"),
        providers,
      ),
    ).toBeNull();
    expect(
      answeringModelLabel(
        { providerSwitch: delivered, turnAssignments: assignments },
        TurnId.make("turn-3"),
        providers,
      ),
    ).toBe("Claude Opus 5.5");
    expect(
      answeringModelLabel(
        { providerSwitch: delivered, turnAssignments: assignments },
        TurnId.make("turn-9"),
        providers,
      ),
    ).toBe("担当モデル不明");
  });
});

describe("makeLatestRequestGate", () => {
  it("lets only the latest request land, and closing voids it", () => {
    const gate = makeLatestRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isCurrent(first)).toBe(false);
    expect(gate.isCurrent(second)).toBe(true);
    gate.cancel();
    expect(gate.isCurrent(second)).toBe(false);
  });
});
