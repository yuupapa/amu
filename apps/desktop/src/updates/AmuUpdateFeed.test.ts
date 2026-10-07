// @effect-diagnostics nodeBuiltinImport:off - Reads the web notice source to compare a shared string.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import {
  AMU_ROLLED_BACK_MESSAGE,
  amuUpdateIncompatibility,
  decodeAmuUpdateManifest,
  defaultAmuUpdateManifestUrl,
  isNewerAmuVersion,
  type AmuUpdateManifest,
} from "./AmuUpdateFeed.ts";

const manifest: AmuUpdateManifest = {
  schema: 1,
  version: "0.0.45",
  platform: "darwin",
  arch: "arm64",
  electronVersion: "44.4.2",
  payload: { url: "https://example.test/p.zip", sha256: "a".repeat(64), size: 10 },
  asarIntegrityHash: "b".repeat(64),
  replace: ["app.asar", "app.asar.unpacked"],
};

describe("isNewerAmuVersion", () => {
  it("compares each part as a number", () => {
    expect(isNewerAmuVersion("0.0.45", "0.0.44")).toBe(true);
    expect(isNewerAmuVersion("0.0.100", "0.0.99")).toBe(true);
    expect(isNewerAmuVersion("0.1.0", "0.0.99")).toBe(true);
    expect(isNewerAmuVersion("0.0.44", "0.0.44")).toBe(false);
    expect(isNewerAmuVersion("0.0.43", "0.0.44")).toBe(false);
  });

  it("never offers versions it cannot read", () => {
    expect(isNewerAmuVersion("0.0.45-nightly.1", "0.0.44")).toBe(false);
    expect(isNewerAmuVersion("latest", "0.0.44")).toBe(false);
    expect(isNewerAmuVersion("0.0.45", "dev")).toBe(false);
  });
});

describe("amuUpdateIncompatibility", () => {
  it("accepts the same Electron and CPU", () => {
    expect(
      amuUpdateIncompatibility(manifest, { electronVersion: "44.4.2", arch: "arm64" }),
    ).toBeNull();
  });

  it("asks for a full replacement when Electron changed", () => {
    expect(
      amuUpdateIncompatibility(manifest, { electronVersion: "44.5.0", arch: "arm64" }),
    ).toContain("replace Amu.app");
  });

  it("refuses a manifest that lists a file twice", () => {
    expect(
      amuUpdateIncompatibility(
        { ...manifest, replace: ["app.asar", "app.asar"] },
        { electronVersion: "44.4.2", arch: "arm64" },
      ),
    ).toContain("twice");
  });

  it("refuses another CPU", () => {
    expect(
      amuUpdateIncompatibility(manifest, { electronVersion: "44.4.2", arch: "x64" }),
    ).toContain("arm64");
  });
});

describe("decodeAmuUpdateManifest", () => {
  effectIt.effect("rejects a manifest that would replace anything but the app code", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decodeAmuUpdateManifest({ ...manifest, replace: ["app.asar", "amu-local.json"] }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  effectIt.effect("rejects a version the installer would refuse", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decodeAmuUpdateManifest({ ...manifest, version: " 0.0.45 " }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  effectIt.effect("rejects a malformed hash", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        decodeAmuUpdateManifest({ ...manifest, asarIntegrityHash: "../../etc" }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
});

it("matches the rollback text the web notice looks for", () => {
  // The web app is a separate package, so compare against its source text.
  const webLogic = NodeFS.readFileSync(
    NodePath.join(
      import.meta.dirname,
      "../../../web/src/components/AmuAppUpdateNotification.logic.ts",
    ),
    "utf8",
  );
  expect(webLogic).toContain(JSON.stringify(AMU_ROLLED_BACK_MESSAGE));
});

it("reads the newest release of yuupapa/amu", () => {
  expect(defaultAmuUpdateManifestUrl("arm64")).toBe(
    "https://github.com/yuupapa/amu/releases/latest/download/amu-update-darwin-arm64.json",
  );
});
