import { describe, expect, it, vi } from "vite-plus/test";

import { handoffNoticeBannerItem } from "./ProviderSwitchBanners";

describe("handoffNoticeBannerItem", () => {
  it("offers to cancel only when picking the holder again would not hand over", () => {
    const onCancel = vi.fn();
    const cancellable = handoffNoticeBannerItem({
      fromLabel: "GPT-6.1 Sol",
      toLabel: "Claude Opus 5.5",
      explain: true,
      onCancel,
    });
    expect(cancellable.onDismiss).toBe(onCancel);
    expect(cancellable.description).toBeDefined();

    const again = handoffNoticeBannerItem({
      fromLabel: "GPT-6.1 Sol",
      toLabel: "GPT-6.1 Sol",
      explain: false,
      onCancel: null,
    });
    expect(again.onDismiss).toBeUndefined();
    expect(again.dismissLabel).toBeUndefined();
    expect(again.description).toBeUndefined();
  });
});
