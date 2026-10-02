import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  dispatchJevHandoff,
  jevRequest,
  nativeJevPlan,
  readJevAuto,
  readJevHandoffs,
  saveJevAuto,
} from "./jev";
import { jevFixtureJob as job } from "../../test/jevFixture";
const entry = {
  jobId: job.id,
  threadId: "thread",
  jevThread: "draft-thread",
  task: job.data.request.task,
  state: "pending" as const,
};
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map([
    ["t3:jev:auto:thread", "true"],
    ["t3:jev:handoffs", JSON.stringify([entry])],
  ]);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
describe("Jev disconnected from normal sending", () => {
  it("does not reactivate saved Auto or rewrite saved choices", () => {
    expect(readJevAuto("thread", true)).toBe(false);
    saveJevAuto("thread", false);
    expect(storage.get("t3:jev:auto:thread")).toBe("true");
  });
  it("keeps pending prompts while preventing any model handoff", async () => {
    const read = vi.fn(async () => job);
    const send = vi.fn(async () => true);
    await dispatchJevHandoff(entry, read, send);
    expect(read).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(readJevHandoffs()[0]).toMatchObject({ task: entry.task, state: "pending" });
    expect(nativeJevPlan(job)).toBeNull();
  });
  it("rejects stale requests before authentication or network access", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(jevRequest("thread", "bootstrap")).rejects.toThrow("停止中");
    expect(fetch).not.toHaveBeenCalled();
  });
});
