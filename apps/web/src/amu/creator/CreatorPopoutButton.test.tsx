import type * as React from "react";
import type { DesktopPreviewBridge } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  popOutCreator: vi.fn<DesktopPreviewBridge["popOutCreator"]>(),
  returnCreator: vi.fn<DesktopPreviewBridge["returnCreator"]>(),
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

import { CreatorPoppedOutNotice, CreatorPopoutButton } from "./CreatorPopoutButton";

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

describe("CreatorPoppedOutNotice", () => {
  it("says where Creator is and brings its window forward or back", async () => {
    await act(() => {
      renderer = create(<CreatorPoppedOutNotice runtimeTabId="creator-tab" />);
    });
    const root = renderer!.root;
    expect(root.findAllByType("p").map((node) => node.children)).toEqual([
      ["Creatorは別ウィンドウで開いています"],
      ["ウィンドウを閉じてもパネルに戻ります"],
    ]);
    const button = (label: string) =>
      root.find((node) => node.props.onClick !== undefined && node.props.children === label);

    await act(() => button("Creatorウィンドウを表示").props.onClick());
    expect(mocks.popOutCreator).toHaveBeenCalledExactlyOnceWith("creator-tab");
    await act(() => button("パネルに戻す").props.onClick());
    expect(mocks.returnCreator).toHaveBeenCalledExactlyOnceWith("creator-tab");
  });
});

describe("CreatorPopoutButton", () => {
  const render = (poppedOut: boolean, disabledReason: string | null = null) =>
    act(() => {
      renderer = create(
        <CreatorPopoutButton
          runtimeTabId="creator-tab"
          poppedOut={poppedOut}
          disabledReason={disabledReason}
        />,
      );
    });
  const button = () => renderer!.root.find((node) => node.props.type === "button");

  it("names its action in words, which change while popped out", async () => {
    await render(false);
    expect(
      renderer!.root.findAll((node) => node.children.includes("別ウィンドウ")).length,
    ).toBeGreaterThan(0);
    await act(() => button().props.onClick());
    expect(mocks.popOutCreator).toHaveBeenCalledExactlyOnceWith("creator-tab");
    await act(() => renderer?.unmount());

    await render(true);
    expect(
      renderer!.root.findAll((node) => node.children.includes("パネルに戻す")).length,
    ).toBeGreaterThan(0);
    await act(() => button().props.onClick());
    expect(mocks.returnCreator).toHaveBeenCalledExactlyOnceWith("creator-tab");
  });

  it("does nothing while disabled, and stays hoverable to say why", async () => {
    await render(false, "録画中は使えません");
    expect(button().props["aria-disabled"]).toBe("true");
    await act(() => button().props.onClick());
    expect(mocks.popOutCreator).not.toHaveBeenCalled();
  });
});
