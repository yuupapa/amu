import { describe, expect, it } from "vite-plus/test";
import {
  decideProviderContinuation,
  isProviderHandoffAllowed,
  type ProviderContinuationInput,
} from "./providerContinuation.ts";

const claude = { instanceId: "claude", driver: "claudeAgent", continuationKey: "claude:home" };
const codex = { instanceId: "codex", driver: "codex", continuationKey: "codex:home:a" };
const codexOtherHome = { instanceId: "codex-2", driver: "codex", continuationKey: "codex:home:b" };

const desire = (
  target: typeof claude,
  options: { requiresNewThreadForModelChange?: boolean; modelChanged?: boolean } = {},
) => ({
  ...target,
  requiresNewThreadForModelChange: options.requiresNewThreadForModelChange ?? false,
  modelChanged: options.modelChanged ?? false,
});

const input = (overrides: Partial<ProviderContinuationInput>): ProviderContinuationInput => ({
  binding: { ...claude, hasResumeCursor: true, awaitingHandoffDelivery: false },
  activeSession: { ...claude, awaitingHandoffDelivery: false },
  desired: desire(claude),
  threadHasPriorConversation: true,
  ...overrides,
});

describe("decideProviderContinuation", () => {
  it("starts fresh when there is no delivered conversation", () => {
    expect(
      decideProviderContinuation(
        input({
          threadHasPriorConversation: false,
          desired: desire(codex, { modelChanged: true }),
        }),
      ),
    ).toBe("fresh");
  });

  it("continues natively with a live session on the same continuation", () => {
    expect(decideProviderContinuation(input({}))).toBe("native");
  });

  it("continues natively from a resumable binding after a restart", () => {
    expect(decideProviderContinuation(input({ activeSession: null }))).toBe("native");
  });

  it("hands off when the driver changes", () => {
    expect(
      decideProviderContinuation(input({ desired: desire(codex, { modelChanged: true }) })),
    ).toBe("handoff");
  });

  it("hands off when the continuation key changes within one driver", () => {
    expect(
      decideProviderContinuation(
        input({
          binding: { ...codex, hasResumeCursor: true, awaitingHandoffDelivery: false },
          activeSession: { ...codex, awaitingHandoffDelivery: false },
          desired: desire(codexOtherHome),
        }),
      ),
    ).toBe("handoff");
  });

  it("hands off after a restart that lost the resume cursor", () => {
    expect(
      decideProviderContinuation(
        input({
          activeSession: null,
          binding: { ...claude, hasResumeCursor: false, awaitingHandoffDelivery: false },
        }),
      ),
    ).toBe("handoff");
  });

  it("hands off when the binding is missing, e.g. imported history or a deleted instance", () => {
    expect(decideProviderContinuation(input({ activeSession: null, binding: null }))).toBe(
      "handoff",
    );
  });

  it("hands off only when the provider needs a new thread for an actual model change", () => {
    expect(
      decideProviderContinuation(
        input({
          desired: desire(claude, { requiresNewThreadForModelChange: true, modelChanged: true }),
        }),
      ),
    ).toBe("handoff");
    expect(
      decideProviderContinuation(
        input({ desired: desire(claude, { requiresNewThreadForModelChange: true }) }),
      ),
    ).toBe("native");
  });

  it("never treats a live switch session that has not received its packet as native", () => {
    expect(
      decideProviderContinuation(
        input({
          binding: { ...codex, hasResumeCursor: true, awaitingHandoffDelivery: true },
          activeSession: { ...codex, awaitingHandoffDelivery: true },
          desired: desire(codex),
        }),
      ),
    ).toBe("handoff");
  });

  it("never resumes a switch binding whose packet was not delivered before a restart", () => {
    expect(
      decideProviderContinuation(
        input({
          activeSession: null,
          binding: { ...codex, hasResumeCursor: true, awaitingHandoffDelivery: true },
          desired: desire(codex),
        }),
      ),
    ).toBe("handoff");
  });

  it("resumes a switch binding natively once its packet was delivered", () => {
    expect(
      decideProviderContinuation(
        input({
          activeSession: null,
          binding: { ...codex, hasResumeCursor: true, awaitingHandoffDelivery: false },
          desired: desire(codex),
        }),
      ),
    ).toBe("native");
  });

  it("ignores a matching binding while a different session is live", () => {
    expect(
      decideProviderContinuation(
        input({
          binding: { ...codex, hasResumeCursor: true, awaitingHandoffDelivery: false },
          activeSession: { ...claude, awaitingHandoffDelivery: false },
          desired: desire(codex),
        }),
      ),
    ).toBe("handoff");
  });
});

describe("isProviderHandoffAllowed", () => {
  const allowedDrivers = ["claudeAgent", "codex"];

  it("allows both directions between allowlisted drivers", () => {
    expect(
      isProviderHandoffAllowed({ fromDriver: "claudeAgent", toDriver: "codex", allowedDrivers }),
    ).toBe(true);
    expect(
      isProviderHandoffAllowed({ fromDriver: "codex", toDriver: "claudeAgent", allowedDrivers }),
    ).toBe(true);
  });

  it("rejects when either side is outside the allowlist", () => {
    expect(
      isProviderHandoffAllowed({ fromDriver: "cursor", toDriver: "codex", allowedDrivers }),
    ).toBe(false);
    expect(
      isProviderHandoffAllowed({ fromDriver: "codex", toDriver: "cursor", allowedDrivers }),
    ).toBe(false);
  });
});
