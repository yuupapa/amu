import { AppWindow } from "lucide-react";

import { previewBridge } from "~/components/preview/previewBridge";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/**
 * Opens (or brings forward) the Creator tab's own window, or returns its page
 * to the panel. The desktop main adopts the window as the tab's guest, so
 * review comments made there still reach the thread.
 */
function runCreatorWindowAction(action: "pop-out" | "return", runtimeTabId: string): void {
  if (!previewBridge) return;
  const operation =
    action === "pop-out" ? previewBridge.popOutCreator : previewBridge.returnCreator;
  void operation(runtimeTabId).catch((error: unknown) => {
    toastManager.add({
      type: "error",
      title:
        action === "pop-out"
          ? "Creatorを別ウィンドウで開けませんでした"
          : "Creatorをここに戻せませんでした",
      description: error instanceof Error ? error.message : "エラーが発生しました。",
    });
  });
}

/** Toolbar toggle for a Creator tab: its own window, or back into the panel. */
export function CreatorPopoutButton({
  runtimeTabId,
  poppedOut,
  disabled = false,
}: {
  runtimeTabId: string;
  poppedOut: boolean;
  disabled?: boolean;
}) {
  const label = poppedOut ? "ここに戻す" : "別ウィンドウで開く";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={poppedOut ? "secondary" : "ghost"}
            size="icon-xs"
            onClick={() => runCreatorWindowAction(poppedOut ? "return" : "pop-out", runtimeTabId)}
            disabled={disabled}
            aria-label={label}
            aria-pressed={poppedOut ? "true" : "false"}
            type="button"
          />
        }
      >
        <AppWindow className={poppedOut ? "text-primary" : undefined} />
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Shown in the panel while the Creator tab's page is in its own window. */
export function CreatorPoppedOutNotice({ runtimeTabId }: { runtimeTabId: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-sm text-muted-foreground">Creatorは別ウィンドウで開いています</p>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => runCreatorWindowAction("pop-out", runtimeTabId)}
        >
          ウィンドウを前に出す
        </Button>
        <Button size="sm" onClick={() => runCreatorWindowAction("return", runtimeTabId)}>
          ここに戻す
        </Button>
      </div>
    </div>
  );
}
