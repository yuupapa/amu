// @effect-diagnostics nodeBuiltinImport:off - proves disabled transport creates no state or child process.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { JevProcessBridge } from "./JevBridge.ts";
describe("Jev removed from the execution path", () => {
  it("rejects all requests despite former opt-in, without starting Python", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "amu-disabled-jev-"));
    const state = NodePath.join(root, "state-that-must-not-be-created");
    try {
      const bridge = new JevProcessBridge(state, "/missing-runner", "/missing-python", true);
      for (const method of ["bootstrap", "decision_request", "create", "get", "action"])
        await expect(bridge.request(method, "fixture-thread", {})).rejects.toThrow("停止中");
      await expect(NodeFSP.stat(state)).rejects.toThrow();
      bridge.close();
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });
});
