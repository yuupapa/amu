import type * as React from "react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type CreatorProposal,
  type DesktopPreviewBridge,
  type EnvironmentId,
  type PreviewSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadPreviewState } from "~/previewStateStore";

const mocks = vi.hoisted(() => ({
  popOutCreator: vi.fn<DesktopPreviewBridge["popOutCreator"]>(),
  returnCreator: vi.fn<DesktopPreviewBridge["returnCreator"]>(),
  state: null as unknown as ThreadPreviewState,
}));

// Base UI's tooltip and menu need a DOM; these tests only need what they wrap.
vi.mock("~/components/ui/tooltip", async () => {
  const { cloneElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    TooltipTrigger: ({
      render,
      children,
    }: {
      render: React.ReactElement;
      children: React.ReactNode;
    }) => cloneElement(render, {}, children),
    TooltipPopup: () => null,
  };
});
vi.mock("~/components/ui/menu", async () => {
  const { cloneElement } = await import("react");
  return {
    Menu: ({ children }: { children: React.ReactNode }) => children,
    MenuTrigger: ({
      render,
      children,
    }: {
      render: React.ReactElement;
      children: React.ReactNode;
    }) => cloneElement(render, {}, children),
    MenuPopup: () => null,
    MenuItem: () => null,
    MenuSeparator: () => null,
  };
});
vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { popOutCreator: mocks.popOutCreator, returnCreator: mocks.returnCreator },
}));
vi.mock("./useCreatorSession", () => ({ useCreatorEnabled: () => true }));
vi.mock("~/previewStateStore", () => ({ useThreadPreviewState: () => mocks.state }));

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";

import { CreatorChip, selectCreatorChipTabId } from "./CreatorChip";
import { setCreatorAttention } from "./creatorAttention";

const threadRef = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-chip"));
const tab = (tabId: string, creator: boolean): PreviewSessionSnapshot =>
  ({
    tabId,
    navStatus: { _tag: "Idle" },
    ...(creator
      ? { creator: { bindingId: "11111111-1111-4111-8111-111111111111", label: "promo" } }
      : {}),
  }) as unknown as PreviewSessionSnapshot;
const previewState = (poppedOut: boolean): ThreadPreviewState =>
  ({
    sessions: { plain: tab("plain", false), creator: tab("creator", true) },
    activeTabId: "plain",
    serverEpoch: "epoch-1",
    desktopByTabId: { creator: { poppedOut } },
  }) as unknown as ThreadPreviewState;

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  mocks.popOutCreator.mockReset().mockResolvedValue(undefined);
  mocks.returnCreator.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const chipButton = () =>
  renderer!.root.find(
    (node) => node.props["aria-label"]?.startsWith?.("Creator") && node.props.onClick,
  );
const runtimeTabId = previewRuntimeTabId(threadRef, "epoch-1", "creator");

describe("CreatorChip", () => {
  it("picks the selected Creator tab, else the first, never a plain tab", () => {
    expect(selectCreatorChipTabId(previewState(false))).toBe("creator");
    expect(
      selectCreatorChipTabId({ ...previewState(false), sessions: { plain: tab("plain", false) } }),
    ).toBeNull();
  });

  it("is shown from the thread's preview state alone, and opens the tab's window", async () => {
    // Nothing about the right panel is read: the chip shows with it closed.
    mocks.state = previewState(false);
    await act(() => {
      renderer = create(<CreatorChip threadRef={threadRef} />);
    });
    expect(chipButton().props["aria-label"]).toBe("Creatorを別ウィンドウで開く");
    await act(() => chipButton().props.onClick());
    expect(mocks.popOutCreator).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
  });

  it("brings an open window forward and shows a pending send confirmation", async () => {
    mocks.state = previewState(true);
    const holder = Symbol("test");
    const open = vi.fn();
    await act(() => {
      setCreatorAttention(runtimeTabId, holder, { proposal: {} as CreatorProposal, open });
      renderer = create(<CreatorChip threadRef={threadRef} />);
    });
    expect(chipButton().props["aria-label"]).toBe("Creatorウィンドウを表示");
    expect(
      renderer!.root.findAll((node) => node.children.includes("要確認")).length,
    ).toBeGreaterThan(0);
    await act(() => chipButton().props.onClick());
    expect(mocks.popOutCreator).toHaveBeenCalledExactlyOnceWith(runtimeTabId);
    act(() => setCreatorAttention(runtimeTabId, holder, null));
  });
});
