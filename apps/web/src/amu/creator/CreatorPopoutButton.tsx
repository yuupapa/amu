import { AppWindow, PanelRightIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { runCreatorWindowAction } from "./creatorWindow";

/**
 * Toolbar toggle for a Creator tab: its own window, or back into the panel.
 * Labelled, unlike the icon-only expand button beside it, so the two read as
 * different actions. The desktop main adopts the window as the tab's guest, so
 * review comments made there still reach the thread.
 */
export function CreatorPopoutButton({
  runtimeTabId,
  poppedOut,
  disabledReason = null,
}: {
  runtimeTabId: string;
  poppedOut: boolean;
  /** Why the button cannot be used now; null when it can. Shown as its tooltip. */
  disabledReason?: string | null;
}) {
  const disabled = disabledReason !== null;
  const label = poppedOut ? "パネルに戻す" : "別ウィンドウ";
  const tooltip =
    disabledReason ??
    (poppedOut ? "Creatorをこのパネルに戻します" : "Creatorを別ウィンドウで大きく開きます");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={poppedOut ? "secondary" : "outline"}
            size="xs"
            onClick={() => {
              if (disabled) return;
              void runCreatorWindowAction(poppedOut ? "return" : "pop-out", runtimeTabId);
            }}
            // aria-disabled rather than disabled, so the tooltip can still say why.
            aria-disabled={disabled ? "true" : undefined}
            type="button"
          />
        }
      >
        {poppedOut ? <PanelRightIcon /> : <AppWindow />}
        {label}
      </TooltipTrigger>
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** Shown in the panel while the Creator tab's page is in its own window. */
export function CreatorPoppedOutNotice({ runtimeTabId }: { runtimeTabId: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">Creatorは別ウィンドウで開いています</p>
        <p className="text-xs text-muted-foreground">ウィンドウを閉じてもパネルに戻ります</p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void runCreatorWindowAction("pop-out", runtimeTabId)}
        >
          Creatorウィンドウを表示
        </Button>
        <Button size="sm" onClick={() => void runCreatorWindowAction("return", runtimeTabId)}>
          パネルに戻す
        </Button>
      </div>
    </div>
  );
}
