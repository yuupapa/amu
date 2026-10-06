import { describe, expect, it } from "vite-plus/test";

import { expandTurnInputText } from "./turnInputText.ts";

describe("expandTurnInputText", () => {
  it("trims plain text and keeps its content", () => {
    expect(expandTurnInputText({ text: "  続けて  " })).toBe("続けて");
  });

  it("returns undefined when nothing is left to send", () => {
    expect(expandTurnInputText({ text: "   \n " })).toBeUndefined();
  });

  it("leaves text without context references unchanged apart from trimming", () => {
    expect(
      expandTurnInputText({ text: "a [[AMU-NOW]] b", context: { records: [] } as never }),
    ).toBe("a [[AMU-NOW]] b");
  });
});
