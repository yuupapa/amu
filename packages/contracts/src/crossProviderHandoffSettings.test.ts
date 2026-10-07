import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("crossProviderHandoff settings", () => {
  it("is on by default and allows Claude and Codex", () => {
    expect(decodeSettings({}).crossProviderHandoff).toEqual({
      enabled: true,
      packetBudgetChars: 60_000,
      allowedDrivers: ["claudeAgent", "codex"],
    });
  });

  it("fills missing fields of a partial stored value", () => {
    expect(
      decodeSettings({ crossProviderHandoff: { enabled: false } }).crossProviderHandoff,
    ).toEqual({
      enabled: false,
      packetBudgetChars: 60_000,
      allowedDrivers: ["claudeAgent", "codex"],
    });
  });

  it("rejects a budget outside 10,000–110,000 characters", () => {
    expect(() => decodePatch({ crossProviderHandoff: { packetBudgetChars: 9_999 } })).toThrow();
    expect(() => decodePatch({ crossProviderHandoff: { packetBudgetChars: 110_001 } })).toThrow();
    expect(
      decodePatch({ crossProviderHandoff: { packetBudgetChars: 110_000 } }).crossProviderHandoff,
    ).toEqual({ packetBudgetChars: 110_000 });
  });
});
