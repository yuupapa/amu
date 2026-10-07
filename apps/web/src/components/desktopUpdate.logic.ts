import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

import { uiFormat, uiText } from "~/uiText";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

// Amu ships its own releases; the update feed reads the same repository.
const DESKTOP_RELEASE_HISTORY_URL = "https://github.com/yuupapa/amu/releases";
const DESKTOP_RELEASE_TAG_URL = `${DESKTOP_RELEASE_HISTORY_URL}/tag`;

/**
 * The main process fills `downloadedVersion` from the updater's `update-downloaded`
 * event, which is dispatched on its own fiber. A download RPC can therefore resolve
 * before that write lands, so fall back to the version the download was started for.
 */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

/** Release notes for an exact downloaded build; nightly suffixes are part of the tag. */
export function getDesktopUpdateReleaseUrl(version: string | null): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${DESKTOP_RELEASE_TAG_URL}/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(): string {
  return DESKTOP_RELEASE_HISTORY_URL;
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return uiText("This install is using the correct architecture.");
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return uiText(
      "This Mac has Apple Silicon, but Amu is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.",
    );
  }
  if (action === "install") {
    return uiText(
      "This Mac has Apple Silicon, but Amu is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.",
    );
  }
  return uiText(
    "This Mac has Apple Silicon, but Amu is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.",
  );
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "available") {
    return state.availableVersion
      ? uiFormat("Amu {0} is available. Click to download.", state.availableVersion)
      : uiText("Update available");
  }
  if (state.status === "downloading") {
    return typeof state.downloadPercent === "number"
      ? uiFormat("Downloading update ({0}%)", Math.floor(state.downloadPercent))
      : uiText("Downloading update");
  }
  if (state.status === "downloaded") {
    return uiFormat(
      "Amu {0} is ready. Click to restart and update.",
      state.downloadedVersion ?? state.availableVersion ?? "",
    );
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return uiFormat("Could not download Amu {0}. Click to try again.", state.availableVersion);
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return uiFormat("Could not install Amu {0}. Click to try again.", state.downloadedVersion);
    }
    if (state.downloadedVersion) {
      return uiFormat("Amu {0} is ready. Click to restart and update.", state.downloadedVersion);
    }
    return state.message ?? uiText("Update failed");
  }
  return uiText("Up to date");
}

export function getDesktopUpdateInstallConfirmationMessage(
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): string {
  const version = state.downloadedVersion ?? state.availableVersion;
  return version
    ? uiFormat(
        "Restart Amu to update to {0}?\n\nConversations and settings stay. A reply that is still running will stop.",
        version,
      )
    : uiText(
        "Restart Amu to update?\n\nConversations and settings stay. A reply that is still running will stop.",
      );
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}
