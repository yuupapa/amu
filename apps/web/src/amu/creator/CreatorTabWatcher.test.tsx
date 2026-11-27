import type * as React from "react";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type CreatorBindingId,
  type DesktopPreviewBridge,
  type EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  popOutCreator: vi.fn<DesktopPreviewBridge["popOutCreator"]>(),
  returnCreator: vi.fn<DesktopPreviewBridge["returnCreator"]>(),
  generation: null as number | null,
  sessionInputs: [] as Array<{ serverTabId: string; enabled: boolean; passive?: boolean }>,
  toast: vi.fn(),
  poppedOutTabs: new Set<string>(),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { popOutCreator: mocks.popOutCreator, returnCreator: mocks.returnCreator },
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("~/previewStateStore", () => ({
  readThreadPreviewState: () => ({
    desktopByTabId: Object.fromEntries(
      [...mocks.poppedOutTabs].map((tabId) => [tabId, { poppedOut: true }]),
    ),
  }),
  useThreadPreviewState: () => ({ sessions: {} }),
}));
vi.mock("./useCreatorSession", () => ({
  useCreatorEnabled: () => true,
  useCreatorSession: (input: { serverTabId: string; enabled: boolean; passive?: boolean }) => {
    mocks.sessionInputs.push(input);
    return { bridge: null, isOwner: false, view: { generation: mocks.generation } };
  },
  useCreatorSettingGate: () => undefined,
}));

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { CreatorTabWatcher } from "./CreatorSessionHost";
import { GalleryTabWatcher } from "../gallery/GalleryTabWatcher";
import { creatorPanelMarks } from "./creatorPanelAutoClose";
import { requestCreatorAutoPopout } from "./creatorWindow";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-creator"));
const threadKey = scopedThreadKey(threadRef);
const panel = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
const panels = () => useRightPanelStore.getState();
const watcher = (tabId: string, poppedOut: boolean, desktopKnown = true) => (
  <CreatorTabWatcher
    key={tabId}
    threadRef={threadRef}
    serverTabId={tabId}
    runtimeTabId={`runtime-${tabId}`}
    bindingId={"11111111-1111-4111-8111-111111111111" as CreatorBindingId}
    poppedOut={poppedOut}
    desktopKnown={desktopKnown}
  />
);
/** Both Creator tabs of the thread, with which are popped out (as the desktop reports it). */
const tabs = (out: { a?: boolean; b?: boolean }) => {
  mocks.poppedOutTabs = new Set(
    Object.entries(out)
      .filter(([, value]) => value)
      .map(([tabId]) => tabId),
  );
  return (
    <>
      {watcher("a", out.a ?? false)}
      {watcher("b", out.b ?? false)}
    </>
  );
};

let renderer: ReactTestRenderer | undefined;
const mount = (element: React.ReactElement) =>
  act(() => {
    renderer = create(element);
  });
const update = (element: React.ReactElement) => act(() => renderer?.update(element));

beforeEach(() => {
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
  creatorPanelMarks.clear(threadKey);
  mocks.popOutCreator.mockReset().mockResolvedValue(undefined);
  mocks.returnCreator.mockReset().mockResolvedValue(undefined);
  mocks.toast.mockReset();
  mocks.generation = null;
  mocks.sessionInputs = [];
  mocks.poppedOutTabs = new Set();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("CreatorTabWatcher right panel", () => {
  it("keeps the panel closed when the window closes", async () => {
    panels().openBrowser(threadRef, "a");
    await mount(tabs({}));
    await update(tabs({ a: true }));
    expect(panel().isOpen).toBe(false);
    // Popped out, the watcher holds the bridge (passively) for the window's comments.
    expect(mocks.sessionInputs.findLast((input) => input.serverTabId === "a")).toMatchObject({
      enabled: true,
      passive: true,
    });

    // Closing the window must not reopen a panel the user dismissed.
    await act(() => panels().openFile(threadRef, "src/other.ts"));
    await act(() => panels().close(threadRef));
    await update(tabs({}));
    expect(panel().isOpen).toBe(false);
    expect(creatorPanelMarks.has(threadKey)).toBe(false);
  });

  it("leaves a panel the user reopened alone, through later pop-outs and returns", async () => {
    panels().openBrowser(threadRef, "a");
    await mount(tabs({}));
    await update(tabs({ a: true }));
    expect(panel().isOpen).toBe(false);

    await act(() => panels().openFile(threadRef, "src/working.ts"));
    // Another Creator popping out does not close the panel the user opened.
    await update(tabs({ a: true, b: true }));
    expect(panel()).toMatchObject({ isOpen: true, activeSurfaceId: "file:src/working.ts" });
    // Nor does a return take the user's tab away.
    await update(tabs({ b: true }));
    await update(tabs({}));
    expect(panel()).toMatchObject({ isOpen: true, activeSurfaceId: "file:src/working.ts" });
  });

  it("keeps the panel closed after every Creator window closes", async () => {
    panels().openBrowser(threadRef, "a");
    await mount(tabs({}));
    await update(tabs({ a: true }));
    await update(tabs({ a: true, b: true }));
    await update(tabs({ b: true }));
    expect(panel().isOpen).toBe(false);
    await update(tabs({}));
    expect(panel().isOpen).toBe(false);
  });

  it("clears persisted marks after restart without reopening the panel", async () => {
    // Persisted by the previous run, which died with the window out.
    creatorPanelMarks.set(threadKey);
    await mount(watcher("a", false, false));
    // Waits for the desktop's report: before it, poppedOut is only a default.
    expect(panel().isOpen).toBe(false);
    await update(watcher("a", false, true));
    expect(panel().isOpen).toBe(false);
    expect(creatorPanelMarks.has(threadKey)).toBe(false);
  });

  it("changes nothing when it first sees a tab that is already popped out", async () => {
    panels().openBrowser(threadRef, "a");
    await mount(watcher("a", true));
    expect(panel().isOpen).toBe(true);
  });
});

describe("CreatorTabWatcher agent-opened tab", () => {
  it("pops the tab out once its session is live", async () => {
    requestCreatorAutoPopout("runtime-a");
    await mount(watcher("a", false));
    // Holds the bridge so the session can go live with the panel closed.
    expect(mocks.sessionInputs.at(-1)).toMatchObject({ enabled: true });
    expect(mocks.popOutCreator).not.toHaveBeenCalled();

    mocks.generation = 1;
    await update(watcher("a", false));
    expect(mocks.popOutCreator).toHaveBeenCalledExactlyOnceWith("runtime-a");
    await update(watcher("a", false));
    expect(mocks.popOutCreator).toHaveBeenCalledOnce();
  });

  it("reports a window failure without opening the panel", async () => {
    mocks.popOutCreator.mockRejectedValue(new Error("Studio did not load"));
    mocks.generation = 1;
    requestCreatorAutoPopout("runtime-a");
    await act(async () => {
      renderer = create(watcher("a", false));
    });
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Creatorを別ウィンドウで開けませんでした" }),
    );
    expect(panel().isOpen).toBe(false);
  });

  it("lets a request that never goes live expire, releasing the bridge it held", async () => {
    vi.useFakeTimers();
    requestCreatorAutoPopout("runtime-a");
    await mount(watcher("a", false));
    expect(mocks.sessionInputs.at(-1)).toMatchObject({ enabled: true });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(mocks.sessionInputs.at(-1)).toMatchObject({ enabled: false });
    mocks.generation = 1;
    await update(watcher("a", false));
    expect(mocks.popOutCreator).not.toHaveBeenCalled();
  });

  it("drops the request with its tab", async () => {
    requestCreatorAutoPopout("runtime-a");
    await mount(watcher("a", false));
    await act(() => renderer?.unmount());
    // The same tab id coming back later is not popped out by the old request.
    mocks.generation = 1;
    await mount(watcher("a", false));
    expect(mocks.popOutCreator).not.toHaveBeenCalled();
  });
});

describe("GalleryTabWatcher window", () => {
  const gallery = (poppedOut: boolean) => (
    <GalleryTabWatcher
      threadRef={threadRef}
      serverTabId="a"
      runtimeTabId="runtime-gallery"
      loaded
      desktopKnown
      poppedOut={poppedOut}
    />
  );

  it("keeps the panel closed after the Gallery window closes", async () => {
    panels().openBrowser(threadRef, "a");
    await mount(gallery(false));
    await update(gallery(true));
    expect(panel().isOpen).toBe(false);
    await update(gallery(false));
    expect(panel().isOpen).toBe(false);
    expect(creatorPanelMarks.has(threadKey)).toBe(false);
  });

  it("reports a window failure without opening a panel", async () => {
    mocks.popOutCreator.mockRejectedValue(new Error("Gallery did not load"));
    requestCreatorAutoPopout("runtime-gallery");
    await mount(gallery(false));
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "ギャラリーを別ウィンドウで開けませんでした" }),
    );
    expect(panel().isOpen).toBe(false);
  });
});
