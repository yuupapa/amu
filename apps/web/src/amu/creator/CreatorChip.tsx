/**
 * 「Creator」 in the chat header: names the thread's Amu Creator tab wherever
 * it is, so it can be reached with the right panel closed or the page in its
 * own window. Its pending send confirmation shows here too, since the panel's
 * banner is out of sight then.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, Clapperboard } from "lucide-react";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { previewBridge } from "~/components/preview/previewBridge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Group } from "~/components/ui/group";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { type ThreadPreviewState, useThreadPreviewState } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { useCreatorAttention } from "./creatorAttention";
import { runCreatorWindowAction } from "./creatorWindow";
import { useCreatorEnabled } from "./useCreatorSession";

/** The thread's Creator tab the chip stands for: the selected one if it is Creator, else the first. */
export function selectCreatorChipTabId(state: ThreadPreviewState): string | null {
  const creatorTabs = Object.values(state.sessions).filter(
    (session) => session.creator !== undefined && session.runtime !== "server",
  );
  return (
    creatorTabs.find((session) => session.tabId === state.activeTabId)?.tabId ??
    creatorTabs[0]?.tabId ??
    null
  );
}

export function CreatorChip({ threadRef }: { threadRef: ScopedThreadRef }) {
  const enabled = useCreatorEnabled(threadRef.environmentId) === true;
  const previewState = useThreadPreviewState(threadRef);
  const tabId = enabled && previewBridge ? selectCreatorChipTabId(previewState) : null;
  const runtimeTabId =
    tabId === null ? null : previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);
  const attention = useCreatorAttention(runtimeTabId);
  if (tabId === null || runtimeTabId === null) return null;
  const poppedOut = previewState.desktopByTabId[tabId]?.poppedOut ?? false;

  const showInPanel = () => useRightPanelStore.getState().openBrowser(threadRef, tabId);
  // Open (or bring forward) the window; a tab that cannot pop out yet shows in the panel.
  const openWindow = () =>
    void runCreatorWindowAction("pop-out", runtimeTabId).then((opened) => {
      if (!opened) showInPanel();
    });
  const label = poppedOut ? "Creatorウィンドウを表示" : "Creatorを別ウィンドウで開く";

  return (
    <Group className="shrink-0" data-creator-chip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={attention ? "warning-outline" : "outline"}
              size="xs"
              onClick={openWindow}
              aria-label={label}
              type="button"
            />
          }
        >
          <Clapperboard />
          Creator
          {attention ? (
            <Badge variant="warning" size="sm">
              要確認
            </Badge>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup>
          {attention ? `${label}（送信の確認が必要な依頼があります）` : label}
        </TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              variant={attention ? "warning-outline" : "outline"}
              size="icon-xs"
              aria-label="Creatorのメニュー"
              type="button"
            />
          }
        >
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end" sideOffset={6}>
          {attention ? (
            <>
              <MenuItem onClick={attention.open}>送信を確認する</MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          {poppedOut ? (
            <>
              <MenuItem onClick={openWindow}>Creatorウィンドウを表示</MenuItem>
              <MenuItem onClick={() => void runCreatorWindowAction("return", runtimeTabId)}>
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
