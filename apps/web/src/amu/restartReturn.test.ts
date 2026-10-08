import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  forgetScreenForRestart,
  rememberScreenForRestart,
  takeScreenAfterRestart,
} from "./restartReturn";

function stubWindow(hash: string) {
  const items = new Map<string, string>();
  vi.stubGlobal("window", {
    location: { hash },
    localStorage: {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    },
  });
  return items;
}

afterEach(() => vi.unstubAllGlobals());

describe("coming back after a restart", () => {
  it("opens the screen it was on, once", () => {
    stubWindow("#/settings/connections");
    rememberScreenForRestart(1_000);
    expect(takeScreenAfterRestart(2_000)).toBe("#/settings/connections");
    expect(takeScreenAfterRestart(2_000)).toBeNull();
  });

  it("forgets it after a few minutes, or when the restart did not happen", () => {
    stubWindow("#/settings/connections");
    rememberScreenForRestart(1_000);
    expect(takeScreenAfterRestart(1_000 + 4 * 60_000)).toBeNull();
    rememberScreenForRestart(1_000);
    forgetScreenForRestart();
    expect(takeScreenAfterRestart(2_000)).toBeNull();
  });

  it("keeps only the app's own routes", () => {
    const items = stubWindow("#/x");
    items.set(
      "amu:return-after-restart",
      JSON.stringify({ hash: "javascript:alert(1)", at: 1_000 }),
    );
    expect(takeScreenAfterRestart(2_000)).toBeNull();
    items.set("amu:return-after-restart", "not json");
    expect(takeScreenAfterRestart(2_000)).toBeNull();
  });
});
