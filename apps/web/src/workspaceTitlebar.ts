export const COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS =
  "[[data-sidebar-state=collapsed]_&]:pl-[var(--workspace-titlebar-content-left)] max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)]";

/**
 * Grows a bar at the top of the window to the titlebar strip while the sidebar
 * is out of the way, so the window controls and the sidebar toggle, which sit
 * in that strip, line up inside it instead of hanging over its edge.
 */
export const COLLAPSED_SIDEBAR_TITLEBAR_HEIGHT_CLASS =
  "[[data-sidebar-state=collapsed]_&]:h-[var(--workspace-topbar-height)] max-md:[[data-sidebar-state=expanded]_&]:h-[var(--workspace-topbar-height)]";
