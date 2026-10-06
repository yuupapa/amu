import { describe, expect, it } from "vite-plus/test";

import { expandProviderTurnText } from "./providerTurnText.ts";

describe("expandProviderTurnText", () => {
  it("passes plain text through when there is nothing to append", () => {
    expect(
      expandProviderTurnText({ text: "続けて", attachments: [], attachmentsDir: "/tmp/a" }),
    ).toEqual({ _tag: "expanded", textWithCitations: "続けて", text: "続けて" });
  });

  it("keeps a missing text missing", () => {
    expect(
      expandProviderTurnText({ text: undefined, attachments: [], attachmentsDir: "/tmp/a" }),
    ).toEqual({ _tag: "expanded", textWithCitations: undefined, text: undefined });
  });

  it("is deterministic, so the handoff can measure the text sendTurn sends", () => {
    const input = { text: "a".repeat(1_000), attachments: [], attachmentsDir: "/tmp/a" };
    expect(expandProviderTurnText(input)).toEqual(expandProviderTurnText(input));
  });
});
