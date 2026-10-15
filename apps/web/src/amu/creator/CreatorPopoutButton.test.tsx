import type { DesktopPreviewBridge } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  popOutCreator: vi.fn<DesktopPreviewBridge["popOutCreator"]>(),
  returnCreator: vi.fn<DesktopPreviewBridge["returnCreator"]>(),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { popOutCreator: mocks.popOutCreator, returnCreator: mocks.returnCreator },
}));

import { CreatorPoppedOutNotice } from "./CreatorPopoutButton";

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
    expect(root.findByType("p").children).toEqual(["Creatorは別ウィンドウで開いています"]);
    const button = (label: string) =>
      root.find((node) => node.props.onClick !== undefined && node.props.children === label);

    await act(() => button("ウィンドウを前に出す").props.onClick());
    expect(mocks.popOutCreator).toHaveBeenCalledExactlyOnceWith("creator-tab");
    await act(() => button("ここに戻す").props.onClick());
    expect(mocks.returnCreator).toHaveBeenCalledExactlyOnceWith("creator-tab");
  });
});
