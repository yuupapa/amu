/**
 * A sidebar thread being dragged toward the chat area. The sidebar owns the
 * drag (dnd-kit) and keeps the row inside the list; this store follows the
 * real pointer so that, once it leaves the list, a floating card can follow
 * it and the chat area can show where the thread would land.
 */
import { create } from "zustand";

import type { ThreadRouteTarget } from "./threadRoutes";

interface ThreadSplitDragStore {
  /** Null when dragging a thread that does not exist yet (a held new-thread button). */
  target: ThreadRouteTarget | null;
  /** Card title for a drag without a thread. */
  label: string | null;
  point: { x: number; y: number } | null;
  /** True while the pointer is beside the sidebar list rather than over it. */
  outside: boolean;
  start: (
    target: ThreadRouteTarget | null,
    getListBounds: () => DOMRect | null,
    label?: string,
  ) => void;
  end: () => void;
}

let detachPointerListener: (() => void) | null = null;

export const useThreadSplitDragStore = create<ThreadSplitDragStore>()((set) => ({
  target: null,
  label: null,
  point: null,
  outside: false,
  start: (target, getListBounds, label) => {
    detachPointerListener?.();
    const onPointerMove = (event: PointerEvent) => {
      const bounds = getListBounds();
      const outside =
        bounds !== null && (event.clientX > bounds.right || event.clientX < bounds.left);
      set({ point: { x: event.clientX, y: event.clientY }, outside });
    };
    window.addEventListener("pointermove", onPointerMove, true);
    detachPointerListener = () => window.removeEventListener("pointermove", onPointerMove, true);
    set({ target, label: label ?? null, point: null, outside: false });
  },
  end: () => {
    detachPointerListener?.();
    detachPointerListener = null;
    set({ target: null, label: null, point: null, outside: false });
  },
}));
