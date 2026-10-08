import { describe, expect, it } from "vite-plus/test";

import { parseReleaseNotesMarkdown } from "./ReleaseNotesView";

describe("Amu release notes", () => {
  it("reads headings, bullets one level deep and paragraphs", () => {
    expect(
      parseReleaseNotesMarkdown(
        "## 新しくできること\n\n- 画像を表示します。\n  - `~/.codex` のファイルです。\n\n補足の文。",
      ),
    ).toEqual([
      { kind: "heading", text: "新しくできること" },
      { kind: "item", depth: 0, text: "画像を表示します。" },
      { kind: "item", depth: 1, text: "`~/.codex` のファイルです。" },
      { kind: "text", text: "補足の文。" },
    ]);
  });

  it("keeps markup as text, so notes cannot add HTML", () => {
    expect(parseReleaseNotesMarkdown("- <img src=x onerror=alert(1)>")).toEqual([
      { kind: "item", depth: 0, text: "<img src=x onerror=alert(1)>" },
    ]);
  });
});
