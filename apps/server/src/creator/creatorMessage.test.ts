import type { CreatorPlace } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildCreatorMessage, type CreatorMessageItem } from "./creatorMessage.ts";

const place: CreatorPlace = {
  x: 0.7,
  y: 0.62,
  compositionFile: "compositions/sc05-shinbashira.html",
  elementSelector: "#sc05-core-rect",
  elementLabel: "金の柱",
};

const item = (overrides: Partial<CreatorMessageItem> = {}): CreatorMessageItem => ({
  number: 3,
  timeSec: 76.2,
  comment: "柱をもう少し太く",
  place,
  imageIndex: 2,
  outdated: false,
  ...overrides,
});

const itemLines = (text: string) => text.split("\n").filter((line) => line.startsWith("【#"));

describe("buildCreatorMessage", () => {
  it("starts with the header and writes one line per comment", () => {
    const text = buildCreatorMessage({
      projectLabel: "shinbashira",
      sourceKind: "hyperframes",
      items: [item(), item({ number: 4 }), item({ number: 5 })],
    });
    expect(text.split("\n").slice(0, 3)).toEqual([
      "Amu Creator から修正依頼（3 件）",
      "プロジェクト：shinbashira",
      "直したら creator_resolve で各コメントを対応済みにしてください",
    ]);
    expect(itemLines(text)).toHaveLength(3);
    expect(itemLines(text)[0]).toBe(
      "【#3】1:16.2｜場面 sc05-shinbashira｜部品 compositions/sc05-shinbashira.html #sc05-core-rect（金の柱）｜位置 右下（x 0.70, y 0.62）｜画像 2 枚目｜指示：柱をもう少し太く",
    );
  });

  it("says when a comment has no place", () => {
    const [line] = itemLines(
      buildCreatorMessage({
        projectLabel: "p",
        sourceKind: "hyperframes",
        items: [item({ place: null, timeSec: 5 })],
      }),
    );
    expect(line).toBe("【#3】0:05.0｜場所なし｜画像 2 枚目｜指示：柱をもう少し太く");
  });

  it("says when a comment has no image", () => {
    const [line] = itemLines(
      buildCreatorMessage({
        projectLabel: "p",
        sourceKind: "hyperframes",
        items: [item({ imageIndex: null })],
      }),
    );
    expect(line).toContain("｜画像なし｜");
    expect(line).not.toContain("枚目");
  });

  it("marks a comment pinned on an older version of the project", () => {
    const [line] = itemLines(
      buildCreatorMessage({
        projectLabel: "p",
        sourceKind: "hyperframes",
        items: [item({ outdated: true })],
      }),
    );
    expect(line).toMatch(/^【#3】1:16\.2｜古い版で打ったコメント｜場面 /);
  });

  it("keeps a 2,000-character comment whole", () => {
    const long = "あ".repeat(1_999) + "終";
    const text = buildCreatorMessage({
      projectLabel: "p",
      sourceKind: "hyperframes",
      items: [item({ comment: long })],
    });
    expect(text).toContain(`指示：${long}`);
  });

  it("names the video for an mp4 review and leaves out scene and part without a file", () => {
    const text = buildCreatorMessage({
      projectLabel: "take-3.mp4",
      sourceKind: "mp4",
      items: [
        item({
          place: {
            x: 0.1,
            y: 0.1,
            compositionFile: null,
            elementSelector: null,
            elementLabel: null,
          },
        }),
      ],
    });
    expect(text.split("\n")[1]).toBe("動画：take-3.mp4");
    expect(itemLines(text)[0]).toBe(
      "【#3】1:16.2｜位置 左上（x 0.10, y 0.10）｜画像 2 枚目｜指示：柱をもう少し太く",
    );
  });

  it("rounds the time without showing 60 seconds", () => {
    const [line] = itemLines(
      buildCreatorMessage({
        projectLabel: "p",
        sourceKind: "hyperframes",
        items: [item({ timeSec: 59.97, place: null })],
      }),
    );
    expect(line).toMatch(/^【#3】1:00\.0｜/);
  });

  it("names the part without a selector or label as the scene only", () => {
    const [line] = itemLines(
      buildCreatorMessage({
        projectLabel: "p",
        sourceKind: "hyperframes",
        items: [
          item({
            place: { ...place, x: 0.5, y: 0.5, elementSelector: null, elementLabel: null },
          }),
        ],
      }),
    );
    expect(line).toBe(
      "【#3】1:16.2｜場面 sc05-shinbashira｜位置 中央（x 0.50, y 0.50）｜画像 2 枚目｜指示：柱をもう少し太く",
    );
  });
});
