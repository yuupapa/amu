import type { DesktopUpdateState } from "@t3tools/contracts";

// What the app update notice shows for a desktop update state. The notice
// asks once per version; closing it hides that version, and the sidebar's
// update button stays for later.

export type AmuUpdateToastView =
  | { readonly kind: "available"; readonly version: string }
  | { readonly kind: "downloading"; readonly version: string; readonly percent: number | null }
  | { readonly kind: "ready"; readonly version: string }
  | { readonly kind: "download-failed"; readonly version: string; readonly message: string | null }
  | { readonly kind: "install-failed"; readonly version: string; readonly message: string | null }
  | { readonly kind: "rolled-back"; readonly version: string };

/** Same text as AMU_ROLLED_BACK_MESSAGE in apps/desktop/src/updates/AmuUpdateFeed.ts. */
export const AMU_ROLLED_BACK_MESSAGE =
  "The new version of Amu did not start, so Amu went back to this version.";

export const AMU_DISMISSED_UPDATE_STORAGE_KEY = "amu:dismissed-update-version";
/** Kept apart from the version key, so closing one notice never re-shows the other. */
export const AMU_DISMISSED_ROLLBACK_STORAGE_KEY = "amu:dismissed-rollback";

export interface AmuUpdateDismissals {
  readonly version: string | null;
  readonly rollback: string | null;
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readDismissedVersion(): string | null {
  return readStored(AMU_DISMISSED_UPDATE_STORAGE_KEY);
}

export function readDismissals(): AmuUpdateDismissals {
  return {
    version: readDismissedVersion(),
    rollback: readStored(AMU_DISMISSED_ROLLBACK_STORAGE_KEY),
  };
}

/** Whether the notice will show this version, so other "downloaded" toasts can stay quiet. */
export function amuUpdateNoticeShowsVersion(version: string | null): boolean {
  return version !== null && readDismissedVersion() !== version;
}

/**
 * The notice for this state: a view, null to show nothing, or "keep" while a
 * background re-check runs, so the notice does not blink away every few
 * minutes. The desktop state machine puts a failed download back to
 * "available" and a failed install back to "downloaded", each with a message.
 */
export function resolveAmuUpdateToastView(
  state: DesktopUpdateState,
  dismissed: AmuUpdateDismissals,
): AmuUpdateToastView | "keep" | null {
  if (state.status === "error" && state.message === AMU_ROLLED_BACK_MESSAGE) {
    // Keyed by the check time, so a later rollback shows again.
    const key = `rolled-back:${state.checkedAt ?? ""}`;
    return key === dismissed.rollback ? null : { kind: "rolled-back", version: key };
  }
  const version = state.downloadedVersion ?? state.availableVersion;
  if (version === null || version === dismissed.version) return null;
  if (state.status === "checking") return "keep";
  if (state.errorContext === "download" && state.availableVersion !== null) {
    return { kind: "download-failed", version, message: state.message };
  }
  if (state.errorContext === "install" && state.downloadedVersion !== null) {
    return { kind: "install-failed", version, message: state.message };
  }
  switch (state.status) {
    case "available":
      return { kind: "available", version };
    case "downloading":
      return {
        kind: "downloading",
        version,
        percent:
          typeof state.downloadPercent === "number" ? Math.floor(state.downloadPercent) : null,
      };
    case "downloaded":
      return { kind: "ready", version };
    default:
      return null;
  }
}
