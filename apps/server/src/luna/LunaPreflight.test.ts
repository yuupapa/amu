import { describe, expect, it } from "vite-plus/test";
import {
  ServerProvider,
  ServerSettings,
  ProviderInstanceId,
  ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { autoChoices } from "@t3tools/shared/lunaAuto";
import { deriveProviderInstanceConfigMap } from "../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { lunaPreflightMessages, resolveLunaPreflight } from "./LunaPreflight.ts";

const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "offline-fixture",
  status: "ready",
  auth: { status: "authenticated", type: "chatgpt" },
  checkedAt: "2026-10-02T00:00:00Z",
  models: [{ slug: "gpt-6-luna", name: "Luna", isCustom: false, capabilities: null }],
});
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const legacy = decodeSettings({
  providers: {
    codex: {
      setupMode: "existing",
      binaryPath: "/offline-codex",
      homePath: "/offline-existing-home",
    },
  },
  providerInstances: { other: { driver: "antigravity", config: {} } },
});
const decodeConfigs = Schema.decodeUnknownSync(ProviderInstanceConfigMap);
const configs = deriveProviderInstanceConfigMap(legacy);
const choices = autoChoices([provider]);

describe("Luna preflight and legacy connection settings", () => {
  it("resolves the same legacy Codex connection as normal sending without migrating settings", () => {
    expect(legacy.providerInstances[ProviderInstanceId.make("codex")]).toBeUndefined();
    const result = resolveLunaPreflight([provider], configs, choices);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.config.binaryPath).toBe("/offline-codex");
    expect(result.config.homePath).toBe("/offline-existing-home");
    expect(legacy.providerInstances[ProviderInstanceId.make("codex")]).toBeUndefined();
  });
  it("preserves explicit per-instance settings and environment rather than replacing them with legacy defaults", () => {
    const settings = decodeSettings({
      providers: { codex: { binaryPath: "/offline-legacy" } },
      providerInstances: {
        codex: {
          driver: "codex",
          config: { binaryPath: "/offline-explicit", homePath: "/offline-account" },
          environment: [{ name: "PATH", value: "/offline-path" }],
        },
      },
    });
    const result = resolveLunaPreflight(
      [provider],
      deriveProviderInstanceConfigMap(settings),
      choices,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.config.binaryPath).toBe("/offline-explicit");
    expect(result.config.homePath).toBe("/offline-account");
    expect(result.instance.environment).toMatchObject([{ name: "PATH", value: "/offline-path" }]);
  });
  it("keeps custom instance routing separate from the default legacy Codex slot", () => {
    const custom = { ...provider, instanceId: ProviderInstanceId.make("codex-other") };
    expect(resolveLunaPreflight([custom], configs, choices)).toMatchObject({
      ok: false,
      code: "config_missing",
    });
  });
  it.each([
    [[], "codex_missing"],
    [[{ ...provider, enabled: false }], "codex_disabled"],
    [[{ ...provider, status: "warning" }], "provider_not_ready"],
    [[{ ...provider, auth: { status: "unauthenticated" } }], "authentication_required"],
    [[{ ...provider, auth: { status: "authenticated", type: "apiKey" } }], "api_auth_unsupported"],
    [[{ ...provider, auth: { status: "authenticated" } }], "auth_method_unconfirmed"],
    [[{ ...provider, models: [] }], "judge_model_unavailable"],
  ] as const)("distinguishes provider/auth/model failure as %s / %s", (providers, code) => {
    expect(resolveLunaPreflight(providers, configs, choices)).toMatchObject({ ok: false, code });
  });
  it("does not silently change auth transport for managed subscription sharing", () => {
    const settings = decodeSettings({ providers: { codex: { setupMode: "managed" } } });
    expect(
      resolveLunaPreflight([provider], deriveProviderInstanceConfigMap(settings), choices),
    ).toMatchObject({ ok: false, code: "managed_auth_unsupported" });
  });
  it("reports malformed settings without leaking paths, credentials or parser details", () => {
    const result = resolveLunaPreflight(
      [provider],
      decodeConfigs({
        codex: { driver: "codex", config: { binaryPath: { privateAccount: "must-not-leak" } } },
      }),
      choices,
    );
    expect(result).toMatchObject({ ok: false, code: "config_invalid" });
    if (result.ok) throw new Error("Expected invalid config");
    expect(result.error).not.toContain("must-not-leak");
    expect(result.error).not.toContain("privateAccount");
  });
  it("reports absent worker choices separately from Codex login", () => {
    expect(resolveLunaPreflight([provider], configs, [])).toMatchObject({
      ok: false,
      code: "choices_unavailable",
    });
  });
  it("reports an explicit conflicting driver instead of bypassing that setting", () => {
    expect(
      resolveLunaPreflight(
        [provider],
        decodeConfigs({ codex: { driver: "cursor", config: {} } }),
        choices,
      ),
    ).toMatchObject({ ok: false, code: "config_driver_mismatch" });
  });
  it("uses fixed Japanese messages without provider diagnostic content", () => {
    for (const message of Object.values(lunaPreflightMessages))
      expect(message).toMatch(/[ぁ-んァ-ヶ一-龯]/u);
  });
});
