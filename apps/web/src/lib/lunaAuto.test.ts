import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { isNewAutoRequest, validateAutoDecision, type AutoChoice } from "@t3tools/shared/lunaAuto";
import { readAutoRecord, runLunaAuto } from "./lunaAuto";
const choices: AutoChoice[] = [
  {
    instanceId: "codex",
    driver: "codex",
    model: "gpt-6-luna",
    name: "Luna",
    effortId: "reasoningEffort",
    efforts: ["low", "high"],
  },
  {
    instanceId: "claude",
    driver: "claudeCode",
    model: "claude-sonnet-5-5",
    name: "Sonnet",
    effortId: "effort",
    efforts: ["medium"],
  },
];
const decision = { model: "gpt-6-luna", effort: "low", reason: "短い文章作成のため" };
let storage: Map<string, string>, held: Set<string>;
beforeEach(() => {
  storage = new Map();
  held = new Set();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
  });
  vi.stubGlobal("navigator", {
    locks: {
      request: async (name: string, _: unknown, fn: (lock: unknown) => Promise<unknown>) => {
        if (held.has(name)) return fn(null);
        held.add(name);
        try {
          return await fn({ name });
        } finally {
          held.delete(name);
        }
      },
    },
  });
});
const fixture = () => ({
  thread: "fixture-thread",
  id: "fixture-request-0000001",
  signal: new AbortController().signal,
  choices,
  decide: vi.fn(async () => decision),
  unchanged: () => true,
  send: vi.fn(async (_decision, _choice, ticket) => ticket.markDispatch()),
});
describe("Luna first-request Auto", () => {
  it("hands one validated model and effort to normal sending exactly once", async () => {
    const f = fixture();
    await runLunaAuto(f);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.send.mock.calls[0]?.[0]).toEqual(decision);
    expect(f.send.mock.calls[0]?.[1]).toEqual(choices[0]);
    expect(readAutoRecord(f.thread)?.state).toBe("sent");
    await expect(runLunaAuto(f)).rejects.toThrow("開始済み");
    expect(f.decide).toHaveBeenCalledOnce();
  });
  it.each(["model", "effort", "reason", "extra"])(
    "rejects an invalid %s without forwarding the request",
    async (field) => {
      const f = fixture();
      f.decide = vi.fn(async () => ({ ...decision, [field]: "invalid" }));
      await expect(runLunaAuto(f)).rejects.toThrow();
      expect(f.send).not.toHaveBeenCalled();
      expect(readAutoRecord(f.thread)?.state).toBe("blocked");
    },
  );
  it("rejects a globally legal effort when it is illegal for the selected model", () => {
    expect(() =>
      validateAutoDecision({ ...decision, model: choices[1]!.model, effort: "high" }, choices),
    ).toThrow();
  });
  it("leaves the request untouched when Luna is unavailable or times out", async () => {
    for (const message of ["Lunaを利用できません", "判定が時間内に完了しませんでした"]) {
      const f = fixture();
      f.thread = message;
      f.decide = vi.fn(async () => {
        throw new Error(message);
      });
      await expect(runLunaAuto(f)).rejects.toThrow(message);
      expect(f.send).not.toHaveBeenCalled();
    }
  });
  it("ignores a result returned after cancellation", async () => {
    const f = fixture(),
      c = new AbortController();
    f.signal = c.signal;
    f.decide = vi.fn(async () => {
      c.abort();
      return decision;
    });
    await expect(runLunaAuto(f)).rejects.toThrow("取り消");
    expect(f.send).not.toHaveBeenCalled();
    expect(readAutoRecord(f.thread)?.state).toBe("cancelled");
  });
  it("blocks changes to the prompt, access setting, selected model or route during judgment", async () => {
    const f = fixture();
    f.unchanged = () => false;
    await expect(runLunaAuto(f)).rejects.toThrow("状態が変わ");
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["judging", "ready", "dispatching", "uncertain", "sent", "blocked", "cancelled"])(
    "never replays a %s record after reload",
    async (state) => {
      storage.set("amu:luna:auto-run:fixture-thread", JSON.stringify({ id: "old-request", state }));
      const f = fixture();
      await expect(runLunaAuto(f)).rejects.toThrow("開始済み");
      expect(f.decide).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    },
  );
  it("does not automatically resend when the normal-send receipt is unknown", async () => {
    const f = fixture();
    f.send = vi.fn(async (_d, _c, t) => {
      t.markDispatch();
      return false;
    });
    await expect(runLunaAuto(f)).rejects.toThrow("受付を確認できません");
    expect(readAutoRecord(f.thread)?.state).toBe("uncertain");
    await expect(runLunaAuto(f)).rejects.toThrow();
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("prevents simultaneous tabs from starting the same request", async () => {
    const f = fixture();
    let release!: (v: typeof decision) => void;
    f.decide = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const first = runLunaAuto(f);
    await expect(runLunaAuto(f)).rejects.toThrow("開始済み");
    release(decision);
    await first;
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("retains the chosen model for conversation continuation", () => {
    const input = {
      enabled: true,
      hasSession: false,
      hasUserMessage: false,
      contextCount: 0,
      multipleModels: false,
    };
    expect(isNewAutoRequest(input)).toBe(true);
    expect(isNewAutoRequest({ ...input, hasSession: true })).toBe(false);
    expect(isNewAutoRequest({ ...input, hasUserMessage: true })).toBe(false);
  });
  it("stops before judgment when reliable persistence is unavailable", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: () => {
        throw new Error("unavailable");
      },
    });
    const f = fixture();
    await expect(runLunaAuto(f)).rejects.toThrow();
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
});
