// @effect-diagnostics nodeBuiltinImport:off - plain temp files around a synchronous loader.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { AutoChoice } from "@t3tools/shared/lunaAuto";
import { describe, expect, it } from "vite-plus/test";

import {
  applyLunaRoutingPolicy,
  DEFAULT_LUNA_ROUTING_POLICY,
  loadLunaRoutingPolicy,
} from "./LunaRoutingPolicy.ts";

const choice = (model: string): AutoChoice => ({
  instanceId: "x",
  model,
  name: model,
  driver: "codex",
  effortId: null,
  efforts: ["default"],
});

describe("applyLunaRoutingPolicy", () => {
  it("offers only the table's models and leaves out costly or older ones", () => {
    const routed = applyLunaRoutingPolicy(
      ["claude-opus-5-5", "claude-fable-5-1", "gpt-6-astra", "gpt-6.1-sol", "grok-4.7"].map(choice),
      DEFAULT_LUNA_ROUTING_POLICY,
    );
    expect(routed.map((c) => c.model)).toEqual(["claude-opus-5-5", "gpt-6.1-sol"]);
  });

  it("falls back to Grok 4.7 only when nothing in the table is available", () => {
    const routed = applyLunaRoutingPolicy(
      ["grok-4.7", "grok-4.6", "composer-2.5"].map(choice),
      DEFAULT_LUNA_ROUTING_POLICY,
    );
    expect(routed.map((c) => c.model)).toEqual(["grok-4.7"]);
  });

  it("keeps every choice on a setup the policy does not cover", () => {
    const routed = applyLunaRoutingPolicy(
      ["composer-2.5"].map(choice),
      DEFAULT_LUNA_ROUTING_POLICY,
    );
    expect(routed.map((c) => c.model)).toEqual(["composer-2.5"]);
  });
});

describe("loadLunaRoutingPolicy", () => {
  it("reads luna-routing.json and falls back to the defaults when it is broken", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "amu-luna-policy-"));
    try {
      expect(loadLunaRoutingPolicy(directory)).toBe(DEFAULT_LUNA_ROUTING_POLICY);
      NodeFS.writeFileSync(
        NodePath.join(directory, "luna-routing.json"),
        JSON.stringify({ preferred: ["gpt-6-luna"], guidance: "short" }),
      );
      expect(loadLunaRoutingPolicy(directory)).toEqual({
        preferred: ["gpt-6-luna"],
        fallback: [],
        guidance: "short",
      });
      NodeFS.writeFileSync(NodePath.join(directory, "luna-routing.json"), "{ broken");
      expect(loadLunaRoutingPolicy(directory)).toBe(DEFAULT_LUNA_ROUTING_POLICY);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
