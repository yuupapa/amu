import type { ThreadRouteTarget } from "../threadRoutes";
import { useThreadSplitDragStore } from "../threadSplitDragStore";

const DRAG_DISTANCE_PX = 6;

/**
 * Drags a sidebar item out over the chat area without dnd-kit, for the tree
 * sidebar whose thread rows are not sortable. A plain click still clicks:
 * with `holdMs` the drag starts only after the press is held that long,
 * otherwise once the pointer moves a few pixels. `onDrop` receives where the
 * pointer was released beside the sidebar.
 */
export function beginSplitPointerDrag(
  event: React.PointerEvent<HTMLElement>,
  options: {
    target: ThreadRouteTarget | null;
    label?: string;
    holdMs?: number;
    onDrop: (point: { x: number; y: number }) => void;
  },
): void {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const origin = { x: event.clientX, y: event.clientY };
  const sidebar = event.currentTarget.closest<HTMLElement>('[data-sidebar="sidebar"]');
  const getBounds = () => sidebar?.getBoundingClientRect() ?? null;
  let active = false;
  let holdTimer: number | null = null;

  const activate = () => {
    if (active) return;
    active = true;
    document.body.style.cursor = "grabbing";
    useThreadSplitDragStore.getState().start(options.target, getBounds, options.label);
  };
  const cleanup = () => {
    if (holdTimer !== null) window.clearTimeout(holdTimer);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onCancel, true);
    window.removeEventListener("keydown", onKey, true);
    if (active) document.body.style.cursor = "";
  };
  const onMove = (move: PointerEvent) => {
    if (active) return;
    const moved = Math.hypot(move.clientX - origin.x, move.clientY - origin.y) > DRAG_DISTANCE_PX;
    if (!moved) return;
    // With a hold, moving early is an ordinary gesture, not a drag.
    if (options.holdMs) cleanup();
    else activate();
  };
  const onUp = (up: PointerEvent) => {
    cleanup();
    if (!active) return;
    // The release is not a click on whatever is under the pointer. The
    // browser sends that click (if any) before the next task.
    const swallowClick = (click: MouseEvent) => click.stopPropagation();
    window.addEventListener("click", swallowClick, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);
    const { outside } = useThreadSplitDragStore.getState();
    useThreadSplitDragStore.getState().end();
    if (outside) options.onDrop({ x: up.clientX, y: up.clientY });
  };
  const onCancel = () => {
    cleanup();
    if (active) useThreadSplitDragStore.getState().end();
  };
  const onKey = (key: KeyboardEvent) => {
    if (key.key === "Escape") onCancel();
  };

  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onCancel, true);
  window.addEventListener("keydown", onKey, true);
  if (options.holdMs) holdTimer = window.setTimeout(activate, options.holdMs);
}
