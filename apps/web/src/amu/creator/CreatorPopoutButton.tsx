import { AppWindow } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { runCreatorWindowAction } from "./creatorWindow";

/**
 * Opens or focuses the separate Creator window.
 * Labelled, unlike the icon-only expand button beside it, so the two read as
 * different actions. The desktop main adopts the window as the tab's guest, so
 * review comments made there still reach the thread.
 */
export function CreatorPopoutButton({
  runtimeTabId,
  poppedOut,
  disabledReason = null,
  appName = "Creator",
}: {
  runtimeTabId: string;
  poppedOut: boolean;
  /** "Creator", or "ギャラリー" for an Amu Gallery tab. */
  appName?: string;
  /** Why the button cannot be used now; null when it can. Shown as its tooltip. */
  disabledReason?: string | null;
}) {
  const disabled = disabledReason !== null;
  const label = poppedOut ? "ウィンドウを表示" : "別ウィンドウ";
  const tooltip =
    disabledReason ??
    (poppedOut ? `${appName}ウィンドウを表示します` : `${appName}を別ウィンドウで大きく開きます`);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={poppedOut ? "secondary" : "outline"}
            size="xs"
            onClick={() => {
              if (disabled) return;
              void runCreatorWindowAction("pop-out", runtimeTabId, appName);
            }}
            // aria-disabled rather than disabled, so the tooltip can still say why.
            aria-disabled={disabled ? "true" : undefined}
            type="button"
          />
        }
      >
        <AppWindow />
        {label}
      </TooltipTrigger>
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/** Shown in the panel while the Creator tab's page is in its own window. */
export function CreatorPoppedOutNotice({
  runtimeTabId,
  appName = "Creator",
}: {
  runtimeTabId: string;
  appName?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{`${appName}は別ウィンドウで開いています`}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void runCreatorWindowAction("pop-out", runtimeTabId, appName)}
        >
          {`${appName}ウィンドウを表示`}
        </Button>
      </div>
    </div>
  );
}
