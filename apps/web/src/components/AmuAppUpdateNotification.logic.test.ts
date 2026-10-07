import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  AMU_ROLLED_BACK_MESSAGE,
  resolveAmuUpdateToastView,
} from "./AmuAppUpdateNotification.logic";

const base: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "0.0.44",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
  releaseNotes: [],
  omittedReleaseCount: 0,
};

const none = { version: null, rollback: null };

describe("resolveAmuUpdateToastView", () => {
  it("asks to download a newly found version", () => {
    expect(
      resolveAmuUpdateToastView({ ...base, status: "available", availableVersion: "0.0.45" }, none),
    ).toEqual({ kind: "available", version: "0.0.45" });
  });

  it("stays quiet for a version the user closed, but asks again for the next one", () => {
    const state = { ...base, status: "available" as const, availableVersion: "0.0.45" };
    expect(resolveAmuUpdateToastView(state, { version: "0.0.45", rollback: null })).toBeNull();
    expect(
      resolveAmuUpdateToastView(
        { ...state, availableVersion: "0.0.46" },
        { version: "0.0.45", rollback: null },
      ),
    ).toEqual({
      kind: "available",
      version: "0.0.46",
    });
  });

  it("shows progress, then the restart step", () => {
    expect(
      resolveAmuUpdateToastView(
        { ...base, status: "downloading", availableVersion: "0.0.45", downloadPercent: 42.7 },
        none,
      ),
    ).toEqual({ kind: "downloading", version: "0.0.45", percent: 42 });
    expect(
      resolveAmuUpdateToastView(
        {
          ...base,
          status: "downloaded",
          availableVersion: "0.0.45",
          downloadedVersion: "0.0.45",
        },
        none,
      ),
    ).toEqual({ kind: "ready", version: "0.0.45" });
  });

  it("offers a retry when the download or install failed", () => {
    expect(
      resolveAmuUpdateToastView(
        {
          ...base,
          status: "error",
          errorContext: "download",
          availableVersion: "0.0.45",
          message: "broken",
        },
        none,
      ),
    ).toEqual({ kind: "download-failed", version: "0.0.45", message: "broken" });
    expect(
      resolveAmuUpdateToastView(
        {
          ...base,
          status: "error",
          errorContext: "install",
          availableVersion: "0.0.45",
          downloadedVersion: "0.0.45",
          message: null,
        },
        none,
      ),
    ).toEqual({ kind: "install-failed", version: "0.0.45", message: null });
  });

  it("reads the failures the desktop state machine actually produces", () => {
    // A failed download goes back to "available"; a failed install to "downloaded".
    expect(
      resolveAmuUpdateToastView(
        {
          ...base,
          status: "available",
          errorContext: "download",
          availableVersion: "0.0.45",
          message: "damaged",
        },
        none,
      ),
    ).toEqual({ kind: "download-failed", version: "0.0.45", message: "damaged" });
    expect(
      resolveAmuUpdateToastView(
        {
          ...base,
          status: "downloaded",
          errorContext: "install",
          availableVersion: "0.0.45",
          downloadedVersion: "0.0.45",
          message: "could not start",
        },
        none,
      ),
    ).toEqual({ kind: "install-failed", version: "0.0.45", message: "could not start" });
  });

  it("keeps the notice while a background re-check runs", () => {
    expect(
      resolveAmuUpdateToastView({ ...base, status: "checking", availableVersion: "0.0.45" }, none),
    ).toBe("keep");
    expect(
      resolveAmuUpdateToastView(
        { ...base, status: "checking", availableVersion: "0.0.45" },
        { version: "0.0.45", rollback: null },
      ),
    ).toBeNull();
  });

  it("says once that a failed update went back to the old version", () => {
    const state = {
      ...base,
      status: "error" as const,
      errorContext: "check" as const,
      message: AMU_ROLLED_BACK_MESSAGE,
      checkedAt: "2026-10-07T00:00:00.000Z",
    };
    const view = resolveAmuUpdateToastView(state, none);
    expect(view).toEqual({ kind: "rolled-back", version: "rolled-back:2026-10-07T00:00:00.000Z" });
    expect(
      resolveAmuUpdateToastView(state, {
        version: null,
        rollback: "rolled-back:2026-10-07T00:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("keeps the rollback notice and the version notice apart", () => {
    const state = { ...base, status: "available" as const, availableVersion: "0.0.45" };
    // Closing a rollback notice does not bring back a version the user closed.
    expect(
      resolveAmuUpdateToastView(state, { version: "0.0.45", rollback: "rolled-back:x" }),
    ).toBeNull();
  });

  it("leaves a failed check to the sidebar button", () => {
    expect(
      resolveAmuUpdateToastView(
        { ...base, status: "error", errorContext: "check", message: "offline" },
        none,
      ),
    ).toBeNull();
    expect(resolveAmuUpdateToastView({ ...base, status: "up-to-date" }, none)).toBeNull();
  });
});
