import type { ScopedThreadRef } from "@t3tools/contracts";
import { Maximize2, Minimize2 } from "lucide-react";
import { useRef } from "react";
import { Button } from "~/components/ui/button";
import { useOptionalSidebar } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

/**
 * One click to give a Creator tab the whole Amu window: the right panel is
 * maximized and the left sidebar folds away. The same webview stays attached,
 * so Creator review comments keep flowing back to the thread.
 */
export function CreatorExpandButton({ threadRef }: { threadRef: ScopedThreadRef }) {
  const expanded = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).maximized === true,
  );
  const sidebar = useOptionalSidebar();
  // Reopen the sidebar on restore only if this button was what closed it.
  const closedSidebarRef = useRef(false);

  const toggle = () => {
    const next = !expanded;
    useRightPanelStore.getState().setMaximized(threadRef, next);
    if (!sidebar || sidebar.isMobile) return;
    if (next && sidebar.open) {
      sidebar.setOpen(false);
      closedSidebarRef.current = true;
    } else if (!next && closedSidebarRef.current) {
      sidebar.setOpen(true);
      closedSidebarRef.current = false;
    }
  };

  const label = expanded ? "元の大きさに戻す" : "Creatorを大きく表示";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={expanded ? "secondary" : "ghost"}
            size="icon-xs"
            onClick={toggle}
            aria-label={label}
            aria-pressed={expanded ? "true" : "false"}
            type="button"
          />
        }
      >
        {expanded ? <Minimize2 className="text-primary" /> : <Maximize2 />}
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
