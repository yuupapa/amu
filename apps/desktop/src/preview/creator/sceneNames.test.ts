import { describe, expect, it } from "vite-plus/test";

import { sceneButtons, sceneLabel, shortSceneName, type SceneSource } from "./sceneNames.ts";

const scene = (overrides: Partial<SceneSource>): SceneSource => ({
  file: null,
  id: null,
  start: 0,
  headings: [],
  texts: [],
  ...overrides,
});

describe("shortSceneName", () => {
  it("keeps a short caption as it is", () => {
    expect(shortSceneName("心柱")).toBe("心柱");
  });

  it("takes the part before a separator", () => {
    expect(shortSceneName("心柱 — 五重塔を支える一本の柱")).toBe("心柱");
    expect(shortSceneName("展望台：地上 350 メートル")).toBe("展望台");
  });

  it("shortens a long caption without separators", () => {
    expect(shortSceneName("東京スカイツリーの心柱制振のしくみ")).toBe("東京スカイツリーの心…");
  });

  it("refuses text without letters", () => {
    expect(shortSceneName("01")).toBeNull();
    expect(shortSceneName("1:25")).toBeNull();
    expect(shortSceneName("  ")).toBeNull();
  });
});

describe("sceneLabel", () => {
  it("uses the first heading", () => {
    expect(
      sceneLabel(
        scene({
          file: "compositions/sc05-shinbashira.html",
          headings: ["心柱"],
          texts: ["揺れの波"],
        }),
      ),
    ).toBe("心柱");
  });

  it("uses the first caption-like text when there is no heading", () => {
    expect(
      sceneLabel(scene({ file: "compositions/sc06-tenbo.html", texts: ["06", "展望台"] })),
    ).toBe("展望台");
  });

  it("falls back to the file name without folder and extension", () => {
    expect(sceneLabel(scene({ file: "compositions/sc05-shinbashira.html", texts: ["05"] }))).toBe(
      "sc05-shinbashira",
    );
  });

  it("falls back to the element id, then a generic name", () => {
    expect(sceneLabel(scene({ id: "scene-intro" }))).toBe("scene-intro");
    expect(sceneLabel(scene({}))).toBe("場面");
  });
});

describe("sceneButtons", () => {
  it("orders scenes by start and makes repeated names distinct", () => {
    expect(
      sceneButtons([
        scene({ start: 12, headings: ["展望台"] }),
        scene({ start: 0, headings: ["心柱"] }),
        scene({ start: 30, headings: ["心柱"] }),
      ]),
    ).toEqual([
      { label: "心柱", start: 0 },
      { label: "展望台", start: 12 },
      { label: "心柱 2", start: 30 },
    ]);
  });

  it("drops scenes with an unusable start", () => {
    expect(sceneButtons([scene({ start: Number.NaN, headings: ["心柱"] })])).toEqual([]);
  });
});
