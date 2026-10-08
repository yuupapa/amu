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

describe("phone help addresses", async () => {
  const { isTailnetAddress, reachabilityCheckUrl } = await import("./phoneConnectHelp");

  it("checks the Mac's own address, also inside a hosted-app link", () => {
    expect(reachabilityCheckUrl("http://192.168.11.25:5233/pair#token=x")).toBe(
      "http://192.168.11.25:5233",
    );
    expect(
      reachabilityCheckUrl(
        "https://app.t3.codes/pair?host=https%3A%2F%2Fmac.tail1234.ts.net&token=x",
      ),
    ).toBe("https://mac.tail1234.ts.net");
    expect(reachabilityCheckUrl("http://127.0.0.1:5233/pair#token=x")).toBeNull();
  });

  it("tells tailnet addresses apart", () => {
    expect(isTailnetAddress("https://mac.tail1234.ts.net")).toBe(true);
    expect(isTailnetAddress("http://100.101.102.103:5233")).toBe(true);
    expect(isTailnetAddress("http://192.168.11.25:5233")).toBe(false);
    expect(isTailnetAddress("http://100.200.1.1:5233")).toBe(false);
  });
});

describe("installing an update", () => {
  it("keeps the screen for an accepted install and forgets it for a refused or failed one", async () => {
    const { installUpdateReturningHere } = await import("./restartReturn");
    const items = stubWindow("#/usage");
    const key = "amu:return-after-restart";
    await installUpdateReturningHere(async () => ({
      accepted: true,
      state: { errorContext: null },
    }));
    expect(items.has(key)).toBe(true);
    await installUpdateReturningHere(async () => ({
      accepted: false,
      state: { errorContext: null },
    }));
    expect(items.has(key)).toBe(false);
    await installUpdateReturningHere(async () => ({
      accepted: true,
      state: { errorContext: "install" },
    }));
    expect(items.has(key)).toBe(false);
    await expect(
      installUpdateReturningHere(async () => {
        throw new Error("bridge failed");
      }),
    ).rejects.toThrow("bridge failed");
    expect(items.has(key)).toBe(false);
  });
});
