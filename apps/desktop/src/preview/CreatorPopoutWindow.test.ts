import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { browserWindowConstructor } = vi.hoisted(() => ({ browserWindowConstructor: vi.fn() }));

vi.mock("electron", () => ({ BrowserWindow: browserWindowConstructor }));

import {
  createCreatorPopoutWindow,
  creatorPopoutBounds,
  creatorPopoutTitle,
} from "./CreatorPopoutWindow.ts";

const makeWindow = () => {
  const listeners = new Map<string, (...args: never[]) => void>();
  const contents = {
    setWindowOpenHandler: vi.fn(),
    stop: vi.fn(),
    on: vi.fn((event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, listener);
    }),
  };
  const window = {
    webContents: contents,
    isDestroyed: () => false,
    close: vi.fn(),
    setTitle: vi.fn(),
  };
  browserWindowConstructor.mockImplementation(function () {
    return window;
  });
  const emit = (event: string, ...args: unknown[]) =>
    (listeners.get(event) as ((...args: unknown[]) => void) | undefined)?.(...args);
  return { window, contents, emit };
};

const open = () => {
  const onLeave = vi.fn();
  const created = makeWindow();
  createCreatorPopoutWindow({
    session: {} as Electron.Session,
    preload: "/app/preview-pick-preload.cjs",
    additionalArguments: [],
    workArea: { x: 0, y: 0, width: 1440, height: 900 },
    pageTitle: "Studio",
    onLeave,
  });
  return { ...created, onLeave };
};

beforeEach(() => {
  browserWindowConstructor.mockReset();
});

describe("creatorPopoutBounds", () => {
  it("is 1600×1000 at most, 90% of a smaller work area, and centred", () => {
    expect(creatorPopoutBounds({ x: 0, y: 25, width: 2560, height: 1415 })).toEqual({
      x: 480,
      y: 233,
      width: 1600,
      height: 1000,
    });
    expect(creatorPopoutBounds({ x: 0, y: 0, width: 1440, height: 900 })).toEqual({
      x: 72,
      y: 45,
      width: 1296,
      height: 810,
    });
  });
});

describe("createCreatorPopoutWindow", () => {
  it("titles the window after Studio's page", () => {
    const { emit, window } = open();
    expect(browserWindowConstructor.mock.calls[0]?.[0]).toMatchObject({
      title: "Amu Creator — Studio",
    });
    const event = { preventDefault: vi.fn() };
    emit("page-title-updated", event, "  ");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(window.setTitle).toHaveBeenCalledWith(creatorPopoutTitle("  "));
  });

  it("keeps the page on loopback Studio and hands anything else on", () => {
    const { emit, contents, onLeave, window } = open();
    const studio = { url: "http://localhost:3002/#project/a", preventDefault: vi.fn() };
    emit("will-navigate", studio);
    expect(studio.preventDefault).not.toHaveBeenCalled();
    const away = { url: "https://example.com/", preventDefault: vi.fn() };
    emit("will-navigate", away);
    expect(away.preventDefault).toHaveBeenCalled();
    expect(onLeave).toHaveBeenCalledWith("https://example.com/");

    // A load that skipped will-navigate (loadURL, a debugger) is stopped as it starts.
    emit("did-start-navigation", {
      url: "https://example.com/other",
      isMainFrame: true,
      isSameDocument: false,
    });
    expect(contents.stop).toHaveBeenCalledOnce();
    emit("did-start-navigation", {
      url: "https://ads.example/frame",
      isMainFrame: false,
      isSameDocument: false,
    });
    expect(contents.stop).toHaveBeenCalledOnce();

    // And one that still committed closes the window.
    emit("did-navigate", {}, "https://example.com/other");
    expect(window.close).toHaveBeenCalledOnce();
    emit("did-navigate", {}, "http://127.0.0.1:3002/");
    expect(window.close).toHaveBeenCalledOnce();
  });
});
