/**
 * Amu Gallery from the web app: whether it is on, the 「Amu ギャラリーを開く」
 * entry of the right panel's new-tab menu, and the Japanese text of its errors.
 * The server starts the media gallery when needed and opens it as this
 * thread's Gallery tab; the panel then shows that tab.
 */
import type { EnvironmentId, ScopedThreadRef, ServerSettings } from "@t3tools/contracts";
import { useMemo } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { toastManager } from "~/components/ui/toast";
import { useRightPanelStore } from "~/rightPanelStore";
import { creatorEnvironment } from "~/state/creator";
import { useServerConfigs } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";

import { toCreatorCallResult } from "../creator/useCreatorSession";

/** Whether Amu Gallery is on for this environment (`undefined` while unknown). */
export function useGalleryEnabled(environmentId: EnvironmentId | null): boolean | undefined {
  const configs = useServerConfigs();
  if (environmentId === null) return undefined;
  const settings: ServerSettings | undefined = configs.get(environmentId)?.settings;
  return settings?.amuGalleryEnabled;
}

const readField = (value: unknown, key: string): string | null => {
  if (typeof value !== "object" || value === null) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : null;
};

export function galleryErrorMessage(error: unknown): string {
  const tag = readField(error, "_tag");
  if (tag === "GalleryDisabledError") {
    return "Amu ギャラリーがオフになっています（設定の「Amu ギャラリー」）";
  }
  if (tag !== "GalleryOperationError") {
    return "サーバーに届きませんでした。少し待ってから、もう一度お試しください";
  }
  const detail = readField(error, "detail") ?? "";
  if (detail.startsWith("gallery_missing")) {
    return "素材ギャラリーのフォルダ（~/YouTube動画/tools/media-gallery）が見つかりません";
  }
  if (detail === "gallery_not_ready") {
    return "素材ギャラリーを起動できませんでした。ポート 8768 を別のアプリが使っていないか確かめてください";
  }
  if (detail === "desktop_only" || detail === "desktop_session_only") {
    return "Amu ギャラリーはこの Mac の Amu アプリでだけ開けます";
  }
  return `Amu ギャラリーを開けませんでした（${detail}）`;
}

export function useGalleryOpener(threadRef: ScopedThreadRef | null): (() => void) | null {
  const enabled = useGalleryEnabled(threadRef?.environmentId ?? null) === true;
  const openByUser = useAtomCommand(creatorEnvironment.galleryOpenByUser, { reportFailure: false });
  return useMemo(() => {
    if (!enabled || threadRef === null || !previewBridge) return null;
    return () => {
      void (async () => {
        const result = toCreatorCallResult(
          await openByUser({
            environmentId: threadRef.environmentId,
            input: { threadId: threadRef.threadId },
          }),
        );
        if (result.ok) {
          useRightPanelStore.getState().openBrowser(threadRef, result.value.tabId);
          return;
        }
        toastManager.add({
          type: "error",
          title: "Amu ギャラリーを開けませんでした",
          description: galleryErrorMessage(result.error),
        });
      })();
    };
  }, [enabled, openByUser, threadRef]);
}
