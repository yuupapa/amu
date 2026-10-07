import { uiFormat, uiText } from "~/uiText";
import { useAtomValue } from "@effect/atom-react";
import type { KeybindingCommand } from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Columns2Icon, Rows2Icon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { ChatPaneContext, type ChatPaneContextValue } from "./ChatPaneContext";
import type { ChatComposerHandle } from "./chat/ChatComposer";
import {
  ComposerHandleContext,
  type ComposerHandleRef,
  useComposerHandleContext,
} from "../composerHandleContext";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";
import { ThreadRouteView } from "./ThreadRouteView";
import { SidebarInset } from "./ui/sidebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useThreadShell } from "../state/entities";
import {
  computeSplitGeometry,
  countSplitPanes,
  findSplitPane,
  findSplitPaneByTarget,
  MAX_SPLIT_PANES,
  resolveSplitDropZone,
  threadRouteTargetKey,
  type SplitDividerRect,
  type SplitPlacement,
  type SplitRect,
} from "../splitLayout.logic";
import { useSplitLayoutStore } from "../splitLayoutStore";
import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useThreadSplitDragStore } from "../threadSplitDragStore";
import {
  buildDraftThreadRouteParams,
  buildThreadRouteParams,
  type ThreadRouteTarget,
} from "../threadRoutes";

function navigateToTarget(
  navigate: ReturnType<typeof useNavigate>,
  target: ThreadRouteTarget,
  replace: boolean,
) {
  if (target.kind === "server") {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(target.threadRef),
      replace,
    });
  } else {
    void navigate({
      to: "/draft/$draftId",
      params: buildDraftThreadRouteParams(target.draftId),
      replace,
    });
  }
}

/**
 * Keeps the route and the focused split pane pointing at the same thread:
 * a route change (sidebar click, new thread) lands in the focused pane, and
 * focusing another pane moves the route to its thread. Always mounted, so a
 * layout that collapses back to one pane still ends on the right thread.
 */
export function SplitRouteSync({ routeTarget }: { routeTarget: ThreadRouteTarget | null }) {
  const navigate = useNavigate();
  const routeKey = threadRouteTargetKey(routeTarget);
  const focusedPaneId = useSplitLayoutStore((state) => state.layout.focusedPaneId);
  const focusedTargetKey = useSplitLayoutStore((state) =>
    threadRouteTargetKey(findSplitPane(state.layout, state.layout.focusedPaneId)?.target ?? null),
  );
  const routeTargetRef = useRef(routeTarget);
  routeTargetRef.current = routeTarget;

  useEffect(() => {
    const target = routeTargetRef.current;
    if (target === null) return;
    useSplitLayoutStore.getState().syncRouteTarget(target);
  }, [routeKey]);

  // A lone pane left empty (its thread closed or deleted) takes the thread
  // the route still shows, so the next split does not blank it.
  const paneCount = useSplitLayoutStore((state) => countSplitPanes(state.layout));
  useEffect(() => {
    const target = routeTargetRef.current;
    const { layout } = useSplitLayoutStore.getState();
    if (target === null || countSplitPanes(layout) !== 1) return;
    if (findSplitPane(layout, layout.focusedPaneId)?.target === null) {
      useSplitLayoutStore.getState().syncRouteTarget(target);
    }
  }, [paneCount, focusedTargetKey, routeKey]);

  useEffect(() => {
    // Read fresh state: the route effect above may have just moved focus.
    const { layout } = useSplitLayoutStore.getState();
    const focused = findSplitPane(layout, layout.focusedPaneId);
    const route = routeTargetRef.current;
    if (!focused?.target || route === null) return;
    if (threadRouteTargetKey(focused.target) === threadRouteTargetKey(route)) return;
    navigateToTarget(navigate, focused.target, true);
  }, [focusedPaneId, focusedTargetKey, navigate, routeKey]);

  return null;
}

let lastTabKeyAt = Number.NEGATIVE_INFINITY;
if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Tab") lastTabKeyAt = performance.now();
    },
    true,
  );
}

/** The chat area when two or more threads are open side by side. */
export function SplitWorkspace() {
  const root = useSplitLayoutStore((state) => state.layout.root);
  const focusedPaneId = useSplitLayoutStore((state) => state.layout.focusedPaneId);
  const focusRequestId = useSplitLayoutStore((state) => state.focusRequestId);
  const geometry = useMemo(() => computeSplitGeometry(root), [root]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);

  useLayoutEffect(() => {
    const node = containerRef.current;
    if (!node) return;
    const update = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh">
      <div ref={containerRef} className="relative min-h-0 flex-1">
        {geometry.panes.map((pane) => (
          <SplitPane
            key={pane.paneId}
            paneId={pane.paneId}
            target={pane.target}
            rect={pane.rect}
            focused={pane.paneId === focusedPaneId}
            focusRequestId={focusRequestId}
            widthPx={size ? Math.round(size.width * pane.rect.width) : null}
            heightPx={size ? Math.round(size.height * pane.rect.height) : null}
            parentDirection={pane.parentDirection}
          />
        ))}
        {geometry.dividers.map((divider) => (
          <SplitDivider
            key={divider.path.join("/") || "root"}
            divider={divider}
            containerRef={containerRef}
          />
        ))}
      </div>
    </SidebarInset>
  );
}

function rectStyle(rect: SplitRect): React.CSSProperties {
  return {
    left: `${rect.left * 100}%`,
    top: `${rect.top * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
}

function SplitPane(props: {
  paneId: string;
  target: ThreadRouteTarget | null;
  rect: SplitRect;
  focused: boolean;
  focusRequestId: number;
  widthPx: number | null;
  heightPx: number | null;
  parentDirection: "row" | "column" | null;
}) {
  const { paneId, target, focused } = props;
  // The app keeps one composer handle for app-wide actions (command palette,
  // file browser). Each pane gets its own so its shortcuts, paste and focus
  // reach its own composer, and the focused pane lends its handle to the app.
  const appComposerRef = useComposerHandleContext();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const paneComposerRef = useMemo(
    () => createPaneComposerRef(appComposerRef, focusedRef),
    [appComposerRef],
  );
  useEffect(() => {
    if (focused && appComposerRef) appComposerRef.current = paneComposerRef.current;
  }, [appComposerRef, focused, paneComposerRef]);
  const threadRef = target?.kind === "server" ? target.threadRef : null;
  const context = useMemo<ChatPaneContextValue>(
    () => ({
      paneId,
      isFocused: focused,
      isSplit: true,
      widthPx: props.widthPx,
      heightPx: props.heightPx,
      // Not zeroed while unfocused: a pane focused by a click must not see
      // this change as a new request and pull focus away from the click.
      focusRequestId: props.focusRequestId,
      threadRef,
    }),
    [focused, paneId, props.focusRequestId, props.heightPx, props.widthPx, threadRef],
  );

  return (
    <div
      data-split-pane-id={paneId}
      className="absolute flex min-h-0 min-w-0 flex-col overflow-hidden p-0.5"
      style={rectStyle(props.rect)}
      onPointerDownCapture={() => {
        if (!focused) useSplitLayoutStore.getState().focusPane(paneId);
      }}
      // Tabbing into another pane makes it the one shortcuts act on. Other
      // focus moves (a background pane focusing itself) do not switch panes.
      onFocusCapture={() => {
        if (!focused && performance.now() - lastTabKeyAt < 300) {
          useSplitLayoutStore.getState().focusPane(paneId);
        }
      }}
    >
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border",
          focused ? "border-primary/60" : "border-border/60",
        )}
      >
        <SplitPaneHeader
          paneId={paneId}
          target={target}
          focused={focused}
          parentDirection={props.parentDirection}
          // The window's top-left corner holds the sidebar toggle (and the
          // traffic lights) when the sidebar is collapsed.
          atWindowTopLeft={props.rect.left === 0 && props.rect.top === 0}
        />
        <div className="relative min-h-0 flex-1">
          <ChatPaneContext.Provider value={context}>
            <ComposerHandleContext value={paneComposerRef}>
              {target ? <ThreadRouteView target={target} paneId={paneId} /> : <EmptyPaneHint />}
            </ComposerHandleContext>
          </ChatPaneContext.Provider>
        </div>
      </div>
    </div>
  );
}

/**
 * A ref the pane's composer writes its handle into. While the pane is focused
 * the handle is also copied to the app-wide ref, so app-wide actions follow
 * the pane the user is working in.
 */
function createPaneComposerRef(
  appComposerRef: ComposerHandleRef | null,
  focusedRef: React.RefObject<boolean>,
): ComposerHandleRef {
  let handle: ChatComposerHandle | null = null;
  return {
    get current() {
      return handle;
    },
    set current(next: ChatComposerHandle | null) {
      handle = next;
      if (focusedRef.current && appComposerRef) appComposerRef.current = next;
    },
  };
}

/** The current key for a split command, following the user's keybindings. */
function useSplitShortcutLabel(command: KeybindingCommand): string | null {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  return useMemo(
    () => shortcutLabelForCommand(keybindings, command, { context: { terminalFocus: false } }),
    [command, keybindings],
  );
}

function withShortcut(label: string, shortcut: string | null): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

function EmptyPaneHint() {
  const splitRight = useSplitShortcutLabel("splitView.splitRight");
  const splitDown = useSplitShortcutLabel("splitView.splitDown");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground text-sm [word-break:auto-phrase]">
      <p>{uiText("Drag a thread here or pick one from the sidebar")}</p>
      {splitRight && splitDown ? (
        <p className="text-xs">
          {uiFormat("Split right with {0}, down with {1}", splitRight, splitDown)}
        </p>
      ) : null}
    </div>
  );
}

function SplitPaneHeader(props: {
  paneId: string;
  target: ThreadRouteTarget | null;
  focused: boolean;
  parentDirection: "row" | "column" | null;
  atWindowTopLeft: boolean;
}) {
  const shell = useThreadShell(props.target?.kind === "server" ? props.target.threadRef : null);
  const title =
    props.target === null
      ? uiText("Empty pane")
      : props.target.kind === "draft"
        ? uiText("New thread")
        : (shell?.title ?? "");
  const iconButton =
    "inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground";
  const DirectionIcon = props.parentDirection === "column" ? Rows2Icon : Columns2Icon;
  const closeLabel = withShortcut(
    uiText("Close pane"),
    useSplitShortcutLabel("splitView.closePane"),
  );
  return (
    <div
      className={cn(
        "flex h-7 shrink-0 items-center gap-1 border-b px-2 text-xs",
        props.focused ? "bg-accent/60 text-foreground" : "text-muted-foreground",
        props.atWindowTopLeft && COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
      )}
    >
      <span
        className="min-w-0 flex-1 truncate"
        // A saved thread title is the user's words; the pane labels above are UI copy.
        translate={props.target?.kind === "server" && title !== "New thread" ? "no" : undefined}
      >
        {title}
      </span>
      <button
        type="button"
        className={iconButton}
        aria-label={uiText("Switch split direction")}
        onClick={() => useSplitLayoutStore.getState().toggleDirection(props.paneId)}
      >
        <DirectionIcon className="size-3.5" />
      </button>
      <button
        type="button"
        className={iconButton}
        aria-label={closeLabel}
        onClick={() => useSplitLayoutStore.getState().closePane(props.paneId)}
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

function SplitDivider(props: {
  divider: SplitDividerRect;
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { divider } = props;
  const isRow = divider.direction === "row";
  const { area, ratio } = divider;
  const style: React.CSSProperties = isRow
    ? {
        left: `calc(${(area.left + area.width * ratio) * 100}% - 3px)`,
        top: `${area.top * 100}%`,
        width: 6,
        height: `${area.height * 100}%`,
      }
    : {
        top: `calc(${(area.top + area.height * ratio) * 100}% - 3px)`,
        left: `${area.left * 100}%`,
        height: 6,
        width: `${area.width * 100}%`,
      };

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = props.containerRef.current;
    if (!container || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const bounds = container.getBoundingClientRect();
    const onMove = (move: PointerEvent) => {
      const next = isRow
        ? ((move.clientX - bounds.left) / bounds.width - area.left) / area.width
        : ((move.clientY - bounds.top) / bounds.height - area.top) / area.height;
      useSplitLayoutStore.getState().setRatio(divider.path, next);
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };

  return (
    <div
      role="separator"
      aria-orientation={isRow ? "vertical" : "horizontal"}
      aria-label={uiText("Drag to resize. Double-click to reset.")}
      className={cn(
        "group absolute z-10 flex items-center justify-center",
        isRow ? "cursor-col-resize" : "cursor-row-resize",
      )}
      style={style}
      onPointerDown={onPointerDown}
      onDoubleClick={() => useSplitLayoutStore.getState().setRatio(divider.path, 0.5)}
    >
      <div
        className={cn(
          "rounded-full bg-transparent transition-colors group-hover:bg-primary/50",
          isRow ? "h-full w-0.5" : "h-0.5 w-full",
        )}
      />
    </div>
  );
}

export function canOpenThreadInSplitPane(threadRef: ScopedThreadRef): boolean {
  const { layout } = useSplitLayoutStore.getState();
  return (
    countSplitPanes(layout) < MAX_SPLIT_PANES ||
    findSplitPaneByTarget(layout, { kind: "server", threadRef }) !== null
  );
}

/** Opens a thread next to the focused pane, or says why it cannot. */
export function openThreadInSplitPane(threadRef: ScopedThreadRef, placement: SplitPlacement) {
  if (useSplitLayoutStore.getState().openInSplit({ kind: "server", threadRef }, placement)) return;
  showSplitFullToast();
}

/** Pane under the pointer, from the split panes or the single-pane chat view. */
export function resolveThreadSplitDrop(point: {
  x: number;
  y: number;
}): { paneId: string; zone: SplitPlacement | "center"; rect: DOMRect } | null {
  const element = document
    .elementsFromPoint(point.x, point.y)
    .map((node) => node.closest<HTMLElement>("[data-split-pane-id]"))
    .find((node): node is HTMLElement => node !== null);
  const paneId = element?.dataset.splitPaneId;
  if (!element || !paneId) return null;
  const rect = element.getBoundingClientRect();
  return { paneId, zone: resolveSplitDropZone(rect, point), rect };
}

/**
 * Opens the dragged thread where it was dropped. Returns true whenever the
 * pointer ended over the chat area, even when the layout was full, so the
 * sidebar never turns that drop into a reorder.
 */
export function commitThreadSplitDrop(
  target: ThreadRouteTarget,
  point: { x: number; y: number },
): boolean {
  const drop = resolveThreadSplitDrop(point);
  if (!drop) return false;
  if (!useSplitLayoutStore.getState().placeThread(target, drop.paneId, drop.zone)) {
    showSplitFullToast();
  }
  return true;
}

function showSplitFullToast() {
  toastManager.add(
    stackedThreadToast({
      type: "info",
      title: uiText("Up to 4 panes"),
      description: uiText("Close a pane before opening another one."),
    }),
  );
}

/** Highlights where a thread dragged from the sidebar would land. */
export function SplitDropOverlay() {
  const target = useThreadSplitDragStore((state) => state.target);
  const point = useThreadSplitDragStore((state) => state.point);
  const outside = useThreadSplitDragStore((state) => state.outside);
  const paneCount = useSplitLayoutStore((state) => countSplitPanes(state.layout));
  const shell = useThreadShell(target?.kind === "server" ? target.threadRef : null);
  if (!target || !point || !outside) return null;
  const drop = resolveThreadSplitDrop(point);
  const blocked = drop !== null && drop.zone !== "center" && paneCount >= MAX_SPLIT_PANES;
  const hint =
    drop === null
      ? uiText("Drop on the chat area to open it")
      : blocked
        ? uiText("Up to 4 panes")
        : drop.zone === "center"
          ? uiText("Open here")
          : uiText("Split here");
  return (
    <>
      {drop ? <SplitDropHighlight rect={drop.rect} zone={drop.zone} blocked={blocked} /> : null}
      <div
        className="pointer-events-none fixed z-50 max-w-64 rounded-md border bg-popover px-2.5 py-1.5 text-popover-foreground shadow-lg"
        style={dragCardPosition(point)}
      >
        {/* A saved title, shown as stored like in the sidebar, even when it reads "New thread". */}
        <div className="truncate text-xs font-medium" translate="no">
          {shell?.title ?? ""}
        </div>
        <div className={cn("text-2xs", blocked ? "text-destructive" : "text-muted-foreground")}>
          {hint}
        </div>
      </div>
    </>
  );
}

/** Beside the pointer, flipped to its left or above it near the window edge. */
function dragCardPosition(point: { x: number; y: number }): React.CSSProperties {
  const CARD_MAX_WIDTH = 256;
  const CARD_HEIGHT = 48;
  const flipX = point.x + 14 + CARD_MAX_WIDTH > window.innerWidth;
  const flipY = point.y + 10 + CARD_HEIGHT > window.innerHeight;
  return {
    ...(flipX ? { right: window.innerWidth - point.x + 14 } : { left: point.x + 14 }),
    ...(flipY ? { bottom: window.innerHeight - point.y + 10 } : { top: point.y + 10 }),
  };
}

function SplitDropHighlight({
  rect,
  zone,
  blocked,
}: {
  rect: DOMRect;
  zone: SplitPlacement | "center";
  blocked: boolean;
}) {
  const half = { width: rect.width / 2, height: rect.height / 2 };
  const box =
    zone === "left"
      ? { left: rect.left, top: rect.top, width: half.width, height: rect.height }
      : zone === "right"
        ? { left: rect.left + half.width, top: rect.top, width: half.width, height: rect.height }
        : zone === "top"
          ? { left: rect.left, top: rect.top, width: rect.width, height: half.height }
          : zone === "bottom"
            ? {
                left: rect.left,
                top: rect.top + half.height,
                width: rect.width,
                height: half.height,
              }
            : { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  return (
    <div
      className={cn(
        "pointer-events-none fixed z-50 rounded-md border-2 transition-all duration-75",
        blocked ? "border-destructive/70 bg-destructive/10" : "border-primary/70 bg-primary/15",
      )}
      style={box}
    />
  );
}
