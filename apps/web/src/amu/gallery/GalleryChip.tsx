/**
 * 「ギャラリー」 in the chat header, beside Creator's chip: names the thread's
 * Amu Gallery tab wherever it is, so it can be reached with the right panel
 * closed or the page in its own window.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, Images } from "lucide-react";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { previewBridge } from "~/components/preview/previewBridge";
import { Button } from "~/components/ui/button";
import { Group } from "~/components/ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { type ThreadPreviewState, useThreadPreviewState } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { runCreatorWindowAction } from "../creator/creatorWindow";
import { useGalleryEnabled } from "./useGalleryOpener";

const APP_NAME = "ギャラリー";

/** The thread's Gallery tab the chip stands for: the selected one if it is Gallery, else the first. */
export function selectGalleryChipTabId(state: ThreadPreviewState): string | null {
  const galleryTabs = Object.values(state.sessions).filter(
    (session) => session.gallery !== undefined && session.runtime !== "server",
  );
  return (
    galleryTabs.find((session) => session.tabId === state.activeTabId)?.tabId ??
    galleryTabs[0]?.tabId ??
    null
  );
}

export function GalleryChip({ threadRef }: { threadRef: ScopedThreadRef }) {
  const enabled = useGalleryEnabled(threadRef.environmentId) === true;
  const previewState = useThreadPreviewState(threadRef);
  const tabId = enabled && previewBridge ? selectGalleryChipTabId(previewState) : null;
  if (tabId === null) return null;
  const runtimeTabId = previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);
  const poppedOut = previewState.desktopByTabId[tabId]?.poppedOut ?? false;

  const showInPanel = () => useRightPanelStore.getState().openBrowser(threadRef, tabId);
  // Open (or bring forward) the window; a tab that cannot pop out yet shows in the panel.
  const openWindow = () =>
    void runCreatorWindowAction("pop-out", runtimeTabId, APP_NAME).then((opened) => {
      if (!opened) showInPanel();
    });
  const label = poppedOut ? "ギャラリーウィンドウを表示" : "ギャラリーを別ウィンドウで開く";

  return (
    <Group className="shrink-0" data-gallery-chip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="xs"
              onClick={openWindow}
              aria-label={label}
              type="button"
            />
          }
        >
          <Images />
          ギャラリー
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant="outline"
              size="icon-xs"
              aria-label="ギャラリーのメニュー"
              type="button"
            />
          }
        >
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end" sideOffset={6}>
          {poppedOut ? (
            <>
              <MenuItem onClick={openWindow}>ギャラリーウィンドウを表示</MenuItem>
              <MenuItem
                onClick={() => void runCreatorWindowAction("return", runtimeTabId, APP_NAME)}
              >
                パネルに戻す
              </MenuItem>
            </>
          ) : (
            <>
              <MenuItem onClick={openWindow}>別ウィンドウで開く</MenuItem>
              <MenuItem onClick={showInPanel}>パネルで表示</MenuItem>
            </>
          )}
        </MenuPopup>
      </Menu>
    </Group>
  );
}
