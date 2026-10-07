import type { ScopedThreadRef } from "@t3tools/contracts";
import { createContext, useContext } from "react";

/**
 * Which split pane a ChatView lives in. Outside the split view every value
 * is the single-pane default, so a lone ChatView behaves exactly as before.
 */
export interface ChatPaneContextValue {
  paneId: string | null;
  /** Window-level shortcuts, paste and focus restoring only act in this pane. */
  isFocused: boolean;
  isSplit: boolean;
  /** Rendered pane width in px, or null when not measured (single pane). */
  widthPx: number | null;
  /** Rendered pane height in px, or null when not measured (single pane). */
  heightPx: number | null;
  /** Bumped when this pane is focused without a click, to move focus into it. */
  focusRequestId: number;
  /** The pane's server thread, for views that would otherwise read the route. */
  threadRef: ScopedThreadRef | null;
}

export const SINGLE_CHAT_PANE: ChatPaneContextValue = {
  paneId: null,
  isFocused: true,
  isSplit: false,
  widthPx: null,
  heightPx: null,
  focusRequestId: 0,
  threadRef: null,
};

export const ChatPaneContext = createContext<ChatPaneContextValue>(SINGLE_CHAT_PANE);

export function useChatPane(): ChatPaneContextValue {
  return useContext(ChatPaneContext);
}

/** Below this height a split pane drops the new-thread headline so it cannot overlap the header. */
export const SPLIT_PANE_DRAFT_HEADLINE_MIN_HEIGHT_PX = 520;

/** Below this width a split pane opens its right panel as a sheet. */
export const SPLIT_PANE_INLINE_RIGHT_PANEL_MIN_WIDTH_PX = 760;
