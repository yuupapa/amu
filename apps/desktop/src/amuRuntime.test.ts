import { assert, describe, it } from "@effect/vitest";

import { resolveAmuRuntimeDefaults } from "./amuRuntime.ts";

describe("resolveAmuRuntimeDefaults", () => {
  it("keeps a packaged Windows install in its own folder and port", () => {
    assert.deepStrictEqual(
      resolveAmuRuntimeDefaults({
        platform: "win32",
        resourcesPath: "C:\\Users\\yu\\AppData\\Local\\Programs\\Amu\\resources",
        env: { APPDATA: "C:\\Users\\yu\\AppData\\Roaming" },
        homedir: "C:\\Users\\yu",
      }),
      { T3CODE_HOME: "C:\\Users\\yu\\AppData\\Roaming\\Amu\\runtime", T3CODE_PORT: "5233" },
    );
  });

  it("leaves explicit Windows settings alone", () => {
    assert.deepStrictEqual(
      resolveAmuRuntimeDefaults({
        platform: "win32",
        resourcesPath: "C:\\Program Files\\Amu\\resources",
        env: { T3CODE_HOME: "D:\\amu", T3CODE_PORT: "6000" },
        homedir: "C:\\Users\\yu",
      }),
      {},
    );
  });

  it("does nothing for Electron run from node_modules", () => {
    assert.deepStrictEqual(
      resolveAmuRuntimeDefaults({
        platform: "win32",
        resourcesPath: "C:\\src\\amu\\node_modules\\electron\\dist\\resources",
        env: {},
        homedir: "C:\\Users\\yu",
      }),
      {},
    );
    assert.deepStrictEqual(
      resolveAmuRuntimeDefaults({
        platform: "darwin",
        resourcesPath: "/src/amu/node_modules/electron/dist/Electron.app/Contents/Resources",
        env: {},
        homedir: "/Users/yu",
      }),
      {},
    );
  });

  it("gives a packaged Mac app only the data folder", () => {
    assert.deepStrictEqual(
      resolveAmuRuntimeDefaults({
        platform: "darwin",
        resourcesPath: "/Applications/Amu.app/Contents/Resources",
        env: {},
        homedir: "/Users/yu",
      }),
      { T3CODE_HOME: "/Users/yu/Library/Application Support/Amu/runtime" },
    );
  });
});
