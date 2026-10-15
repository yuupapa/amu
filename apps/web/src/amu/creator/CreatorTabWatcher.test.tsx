import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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
  sessionInputs: [] as Array<{ enabled: boolean; passive?: boolean }>,
  toast: vi.fn(),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { popOutCreator: mocks.popOutCreator, returnCreator: mocks.returnCreator },
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("./useCreatorSession", () => ({
  useCreatorEnabled: () => true,
  useCreatorSession: (input: { enabled: boolean; passive?: boolean }) => {
    mocks.sessionInputs.push(input);
    return { bridge: null, isOwner: false, view: { generation: mocks.generation } };
  },
  useCreatorSettingGate: () => undefined,
}));

import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

import { CreatorTabWatcher } from "./CreatorSessionHost";
import { requestCreatorAutoPopout } from "./creatorWindow";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-creator"));
const panel = () =>
  selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
const render = (poppedOut: boolean) => (
  <CreatorTabWatcher
    threadRef={threadRef}
    serverTabId="creator-tab"
    runtimeTabId="runtime-creator-tab"
    bindingId={"11111111-1111-4111-8111-111111111111" as CreatorBindingId}
    poppedOut={poppedOut}
  />
);

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  useRightPanelStore.setState({
    byThreadKey: {},
    threadPanelVisibilityByThreadKey: {},
    userActionRevisionByThreadKey: {},
  });
  mocks.popOutCreator.mockReset().mockResolvedValue(undefined);
  mocks.returnCreator.mockReset().mockResolvedValue(undefined);
  mocks.toast.mockReset();
  mocks.generation = null;
  mocks.sessionInputs = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("CreatorTabWatcher right panel", () => {
  it("closes the panel on pop-out, leaves a manual reopen alone, and reopens it on return", async () => {
    useRightPanelStore.getState().openBrowser(threadRef, "creator-tab");
    await act(() => {
      renderer = create(render(false));
    });
    expect(panel().isOpen).toBe(true);

    await act(() => renderer?.update(render(true)));
    expect(panel().isOpen).toBe(false);
    // Popped out, the watcher holds the bridge (passively) for the window's comments.
    expect(mocks.sessionInputs.at(-1)).toMatchObject({ enabled: true, passive: true });

    // The user opens the panel again while the window is still out: it stays open.
    await act(() => useRightPanelStore.getState().show(threadRef));
    await act(() => renderer?.update(render(true)));
    expect(panel().isOpen).toBe(true);

    // Closing the window with × only flips poppedOut; the panel shows the tab again.
    await act(() => useRightPanelStore.getState().close(threadRef));
    await act(() => useRightPanelStore.getState().openFile(threadRef, "src/other.ts"));
    await act(() => useRightPanelStore.getState().close(threadRef));
    await act(() => renderer?.update(render(false)));
    expect(panel()).toMatchObject({ isOpen: true, activeSurfaceId: "browser:creator-tab" });
  });

  it("changes nothing when it first sees a tab that is already popped out", async () => {
    useRightPanelStore.getState().openBrowser(threadRef, "creator-tab");
    await act(() => {
      renderer = create(render(true));
    });
    expect(panel().isOpen).toBe(true);
  });
});

describe("CreatorTabWatcher agent-opened tab", () => {
  it("pops the tab out once its session is live", async () => {
    requestCreatorAutoPopout("runtime-creator-tab");
    await act(() => {
      renderer = create(render(false));
    });
    // Holds the bridge so the session can go live with the panel closed.
    expect(mocks.sessionInputs.at(-1)).toMatchObject({ enabled: true });
    expect(mocks.popOutCreator).not.toHaveBeenCalled();

    mocks.generation = 1;
    await act(() => renderer?.update(render(false)));
    expect(mocks.popOutCreator).toHaveBeenCalledExactlyOnceWith("runtime-creator-tab");
    await act(() => renderer?.update(render(false)));
    expect(mocks.popOutCreator).toHaveBeenCalledOnce();
  });

  it("stays in the panel, with a toast, when the window cannot open", async () => {
    mocks.popOutCreator.mockRejectedValue(new Error("Studio did not load"));
    mocks.generation = 1;
    requestCreatorAutoPopout("runtime-creator-tab");
    await act(async () => {
      renderer = create(render(false));
    });
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Creatorを別ウィンドウで開けませんでした" }),
    );
    expect(panel()).toMatchObject({ isOpen: true, activeSurfaceId: "browser:creator-tab" });
  });
});
