/**
 * 「Amu Creator を開く」 from the right panel's new-tab menu: the user picks a
 * HyperFrames project folder or a video, and the server opens it as a Creator
 * tab of this thread. Available only in the desktop app with the setting on.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { toastManager } from "~/components/ui/toast";
import { creatorEnvironment } from "~/state/creator";
import { useAtomCommand } from "~/state/use-atom-command";

import { creatorErrorMessage } from "./creatorText";
import { toCreatorCallResult, useCreatorEnabled } from "./useCreatorSession";

export interface CreatorOpener {
  readonly openFolder: () => void;
  readonly openVideo: () => void;
}

export function useCreatorOpener(threadRef: ScopedThreadRef | null): CreatorOpener | null {
  const enabled = useCreatorEnabled(threadRef?.environmentId ?? null) === true;
  const openByUser = useAtomCommand(creatorEnvironment.openByUser, { reportFailure: false });
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  return useMemo(() => {
    const desktop = typeof window === "undefined" ? undefined : window.desktopBridge;
    const preview = previewBridge;
    if (!enabled || environmentId === null || threadId === null || !desktop || !preview) {
      return null;
    }
    const open = async (pick: () => Promise<string | null>) => {
      const path = await pick().catch(() => null);
      if (!path) return;
      const result = toCreatorCallResult(
        await openByUser({ environmentId, input: { threadId, path } }),
      );
      if (!result.ok) {
        toastManager.add({
          type: "error",
          title: "Amu Creator を開けませんでした",
          description: creatorErrorMessage(result.error),
        });
      }
    };
    return {
      openFolder: () => void open(() => desktop.pickFolder()),
      openVideo: () => void open(() => preview.pickCreatorVideo()),
    };
  }, [enabled, environmentId, openByUser, threadId]);
}
