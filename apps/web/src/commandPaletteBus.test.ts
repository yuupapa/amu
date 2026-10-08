import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { openCommandPalette, takePendingNewThreadSplit } from "./commandPaletteBus";

beforeEach(() => {
  vi.stubGlobal("window", { dispatchEvent: () => true });
  vi.stubGlobal(
    "CustomEvent",
    class {
      constructor(
        readonly type: string,
        readonly init?: unknown,
      ) {}
    },
  );
});

afterEach(() => {
  takePendingNewThreadSplit();
  vi.unstubAllGlobals();
});

describe("new-thread split through the command palette", () => {
  it("hands the requested split to one new thread only", () => {
    openCommandPalette({
      open: "new-thread-in",
      newThreadSplit: { kind: "beside", placement: "right" },
    });

    expect(takePendingNewThreadSplit()).toEqual({ kind: "beside", placement: "right" });
    expect(takePendingNewThreadSplit()).toBeNull();
  });

  it("forgets an earlier split when the palette is opened without one", () => {
    openCommandPalette({
      open: "new-thread-in",
      newThreadSplit: { kind: "beside", placement: "bottom" },
    });
    openCommandPalette({ open: "new-thread-in" });

    expect(takePendingNewThreadSplit()).toBeNull();
  });
});
