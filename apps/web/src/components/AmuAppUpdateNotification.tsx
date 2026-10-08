import { uiFormat, uiText } from "~/uiText";
import { DownloadIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ensureLocalApi } from "../localApi";
import { useDesktopUpdateState } from "../state/desktopUpdate";
import {
  AMU_DISMISSED_ROLLBACK_STORAGE_KEY,
  AMU_DISMISSED_UPDATE_STORAGE_KEY,
  AMU_ROLLED_BACK_MESSAGE,
  readDismissals,
  resolveAmuUpdateToastView,
  type AmuUpdateToastView,
} from "./AmuAppUpdateNotification.logic";
import {
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateReleaseUrl,
} from "./desktopUpdate.logic";
import { openDesktopUpdateReleaseNotes } from "./desktopUpdate.toast";
import { AmuReleaseNotes } from "../amu/ReleaseNotesView";
import { hiddenToastActionProps, stackedThreadToast, toastManager } from "./ui/toast";

// "A new Amu is out — download it?" as a corner notice, like the CLI update
// notice. It follows the desktop update state: available → downloading →
// ready to restart. Closing it hides that version until the next one.

type ToastId = ReturnType<typeof toastManager.add>;

function showBridgeError(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: uiText(title),
      description: error instanceof Error ? error.message : uiText("An unexpected error occurred."),
    }),
  );
}

export function AmuAppUpdateNotification() {
  const state = useDesktopUpdateState();
  const [dismissals, setDismissals] = useState(readDismissals);
  const [pending, setPending] = useState(false);
  const toastIdRef = useRef<ToastId | null>(null);
  // Set while this component closes its own toast, so that close is not
  // taken as the user hiding the version.
  const closingOwnToastRef = useRef(false);
  const resolved = useMemo(
    () => (state ? resolveAmuUpdateToastView(state, dismissals) : null),
    [state, dismissals],
  );

  const dismiss = useCallback((view: AmuUpdateToastView) => {
    const isRollback = view.kind === "rolled-back";
    try {
      window.localStorage.setItem(
        isRollback ? AMU_DISMISSED_ROLLBACK_STORAGE_KEY : AMU_DISMISSED_UPDATE_STORAGE_KEY,
        view.version,
      );
    } catch {
      // The notice still closes for this session.
    }
    toastIdRef.current = null;
    setDismissals((current) =>
      isRollback ? { ...current, rollback: view.version } : { ...current, version: view.version },
    );
  }, []);

  const closeOwnToast = useCallback(() => {
    if (toastIdRef.current === null) return;
    closingOwnToastRef.current = true;
    toastManager.close(toastIdRef.current);
    closingOwnToastRef.current = false;
    toastIdRef.current = null;
  }, []);

  const download = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    setPending(true);
    void bridge
      .downloadUpdate()
      .catch((error: unknown) => showBridgeError("Could not start update download", error))
      .finally(() => setPending(false));
  }, []);

  const install = useCallback(async () => {
    const bridge = window.desktopBridge;
    if (!bridge || !state) return;
    setPending(true);
    try {
      const confirmed = await ensureLocalApi().dialogs.confirm(
        getDesktopUpdateInstallConfirmationMessage(state),
      );
      // A failed install comes back as the "install-failed" state.
      if (confirmed) await bridge.installUpdate();
    } catch (error) {
      showBridgeError("Could not install update", error);
    } finally {
      setPending(false);
    }
  }, [state]);

  useEffect(() => {
    if (resolved === "keep") return;
    if (resolved === null) {
      closeOwnToast();
      return;
    }
    const view = resolved;
    // "詳しくはこちら" opens the notes that came with the update, in the notice itself.
    const notesText =
      view.kind === "available" || view.kind === "downloading" || view.kind === "ready"
        ? notesFor(state, view.version)
        : null;
    const payload = {
      ...stackedThreadToast({
        ...toastContent(view, {
          download,
          install: () => void install(),
          pending,
          hasNotes: notesText !== null,
        }),
        timeout: 0,
        data: {
          hideCopyButton: true,
          leadingIcon: <DownloadIcon aria-hidden="true" className="size-4 text-success" />,
          ...(notesText
            ? {
                expandableContent: (
                  <AmuReleaseNotes
                    text={notesText}
                    releaseUrl={getDesktopUpdateReleaseUrl(view.version)}
                  />
                ),
                expandableLabels: { expand: "詳しくはこちら", collapse: "閉じる" },
              }
            : {}),
        },
      }),
      // Any close by the user (button, Escape, swipe) hides this version.
      onClose: () => {
        if (!closingOwnToastRef.current) dismiss(view);
      },
    };
    if (toastIdRef.current === null) {
      toastIdRef.current = toastManager.add(payload);
    } else {
      toastManager.update(toastIdRef.current, payload);
    }
  }, [resolved, state, download, install, pending, dismiss, closeOwnToast]);

  useEffect(() => closeOwnToast, [closeOwnToast]);

  return null;
}

/** The offered version's notes, when they came with it. */
function notesFor(state: ReturnType<typeof useDesktopUpdateState>, version: string): string | null {
  if (!state || (state.availableVersion !== version && state.downloadedVersion !== version))
    return null;
  const text = state.releaseNotesText?.trim();
  return text ? text : null;
}

function ReleaseNotesButton({ version }: { version: string }) {
  const releaseUrl = getDesktopUpdateReleaseUrl(version);
  if (!releaseUrl) return null;
  return (
    <button
      className="ml-1 cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-4 hover:text-foreground"
      onClick={() => void openDesktopUpdateReleaseNotes(window.desktopBridge, releaseUrl)}
      type="button"
    >
      {uiText("What's new")}
    </button>
  );
}

function toastContent(
  view: AmuUpdateToastView,
  actions: { download: () => void; install: () => void; pending: boolean; hasNotes: boolean },
) {
  switch (view.kind) {
    case "available":
      return {
        type: "info" as const,
        title: uiFormat("Amu {0} is available", view.version),
        description: (
          <>
            {uiText("Download it now? Conversations and settings stay as they are.")}
            {actions.hasNotes ? null : <ReleaseNotesButton version={view.version} />}
          </>
        ),
        actionProps: {
          children: uiText("Download"),
          disabled: actions.pending,
          onClick: actions.download,
        },
      };
    case "downloading":
      return {
        type: "loading" as const,
        title:
          view.percent === null
            ? uiFormat("Downloading Amu {0}", view.version)
            : uiFormat("Downloading Amu {0} ({1}%)", view.version, view.percent),
        description: uiText("You can keep working while it downloads."),
        actionProps: hiddenToastActionProps,
      };
    case "ready":
      return {
        type: "success" as const,
        title: uiFormat("Amu {0} is ready", view.version),
        description: uiText(
          "Restart Amu to finish. If the new version does not start, Amu goes back to this one.",
        ),
        actionProps: {
          children: uiText("Restart and update"),
          disabled: actions.pending,
          onClick: actions.install,
        },
      };
    case "download-failed":
      return {
        type: "error" as const,
        title: uiFormat("Could not download Amu {0}", view.version),
        description: view.message
          ? uiText(view.message)
          : uiText("Check the connection and try again."),
        actionProps: {
          children: uiText("Try again"),
          disabled: actions.pending,
          onClick: actions.download,
        },
      };
    case "rolled-back":
      return {
        type: "warning" as const,
        title: uiText("The update did not finish"),
        description: uiText(AMU_ROLLED_BACK_MESSAGE),
        actionProps: hiddenToastActionProps,
      };
    case "install-failed":
      return {
        type: "error" as const,
        title: uiFormat("Could not update to Amu {0}", view.version),
        description: view.message
          ? uiText(view.message)
          : uiText("Amu is still on the current version."),
        actionProps: {
          children: uiText("Try again"),
          disabled: actions.pending,
          onClick: actions.install,
        },
      };
  }
}
