/**
 * The window an Amu Creator tab's page moves into when it is popped out of the
 * panel. PreviewManager adopts the window's webContents as the tab's guest, so
 * the Creator overlay, review comments and agent control keep working; only
 * the surface changes, from a `<webview>` to a real window at native size.
 */
import { BrowserWindow } from "electron";

import { isCreatorGuestUrl } from "./creatorSessions.ts";

const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 1000;
const MIN_WIDTH = 640;
const MIN_HEIGHT = 400;
const WORK_AREA_SHARE = 0.9;

export interface CreatorPopoutRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Up to 1600×1000 but never past 90% of the work area, centred in it. */
export const creatorPopoutBounds = (workArea: CreatorPopoutRect): CreatorPopoutRect => {
  const width = Math.round(
    Math.max(
      Math.min(MIN_WIDTH, workArea.width),
      Math.min(DEFAULT_WIDTH, workArea.width * WORK_AREA_SHARE),
    ),
  );
  const height = Math.round(
    Math.max(
      Math.min(MIN_HEIGHT, workArea.height),
      Math.min(DEFAULT_HEIGHT, workArea.height * WORK_AREA_SHARE),
    ),
  );
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height,
  };
};

export const creatorPopoutTitle = (pageTitle: string): string => {
  const label = pageTitle.trim();
  return label.length > 0 ? `Amu Creator — ${label}` : "Amu Creator";
};

/**
 * Opens the (hidden) window. Navigation is kept on the loopback Studio page:
 * a main-frame navigation anywhere else is cancelled and handed to `onLeave`,
 * which opens it as a preview tab instead.
 */
export const createCreatorPopoutWindow = (options: {
  readonly session: Electron.Session;
  readonly preload: string;
  readonly additionalArguments: ReadonlyArray<string>;
  readonly workArea: CreatorPopoutRect;
  readonly pageTitle: string;
  readonly onLeave: (url: string) => void;
}): BrowserWindow => {
  const window = new BrowserWindow({
    ...creatorPopoutBounds(options.workArea),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: creatorPopoutTitle(options.pageTitle),
    show: false,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    autoHideMenuBar: true,
    backgroundColor: "#111111",
    webPreferences: {
      session: options.session,
      preload: options.preload,
      // The posture of the preview `<webview>` (see WebviewPreferences.ts): the
      // picker and Creator overlay share the page's globalThis, so the sandbox
      // is what keeps Node out of the page's reach.
      sandbox: true,
      contextIsolation: false,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webviewTag: false,
      additionalArguments: [...options.additionalArguments],
    },
  });
  const contents = window.webContents;
  // PreviewManager installs the preview popup policy once it adopts the guest.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("page-title-updated", (event, title) => {
    event.preventDefault();
    window.setTitle(creatorPopoutTitle(title));
  });
  contents.on("will-navigate", (event) => {
    if (isCreatorGuestUrl(event.url)) return;
    event.preventDefault();
    options.onLeave(event.url);
  });
  contents.on("will-redirect", (event) => {
    if (event.isMainFrame && !isCreatorGuestUrl(event.url)) event.preventDefault();
  });
  // Closing returns the page to the panel, which reloads it; a beforeunload
  // prompt must not leave the window stuck open.
  contents.on("will-prevent-unload", (event) => {
    event.preventDefault();
  });
  // A crashed page would leave a blank window; the panel reloads it instead.
  contents.on("render-process-gone", () => {
    if (!window.isDestroyed()) window.close();
  });
  return window;
};
