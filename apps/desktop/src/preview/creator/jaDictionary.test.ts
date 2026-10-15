import { describe, expect, it } from "vite-plus/test";

import { translate } from "./jaDictionary.ts";

describe("translate", () => {
  it("translates a pattern whose argument is itself a dictionary entry", () => {
    expect(translate("Close Compositions")).toBe("「コンポジション」を閉じる");
  });

  it("translates a pattern with numbers and keeps the easing name", () => {
    expect(translate("Edit power2.in easing after 8.5s")).toBe(
      "8.5 秒からの動きの緩急（power2.in）を編集",
    );
  });

  it("translates exact dictionary entries", () => {
    expect(translate("Timeline")).toBe("タイムライン");
    expect(translate("Snap enabled (S)")).toBe("スナップ：オン（S キー）");
    expect(translate("Play / Pause")).toBe("再生／一時停止");
  });

  it("keeps surrounding whitespace", () => {
    expect(translate("  Export ")).toBe("  書き出し ");
  });

  it("translates counted patterns", () => {
    expect(translate("Renders (3)")).toBe("書き出し履歴（3）");
    expect(translate("12 lint findings")).toBe("指摘 12 件");
    expect(translate("1 clip")).toBe("1 個のクリップ");
    expect(translate("Opacity keyframe at 2.25s (before clip)")).toBe(
      "2.25 秒の「不透明度」キーフレーム（クリップ開始前）",
    );
  });

  it("leaves unknown text, numbers and Japanese alone", () => {
    expect(translate("Hyperframes Studio rocks")).toBeNull();
    expect(translate("00:12")).toBeNull();
    expect(translate("書き出し")).toBeNull();
    expect(translate("")).toBeNull();
    expect(translate("   ")).toBeNull();
  });

  it("does not translate its own output again", () => {
    for (const source of [
      "Close Compositions",
      "Edit power2.in easing after 8.5s",
      "Snap enabled (S)",
      "Intro, 1.5 to 3 seconds",
      "Auto · Inter",
      "Render final",
    ]) {
      const once = translate(source);
      expect(once).not.toBeNull();
      expect(translate(once ?? "")).toBeNull();
    }
  });

  it("does not treat inherited object keys as entries", () => {
    expect(translate("constructor")).toBeNull();
    expect(translate("toString")).toBeNull();
  });

  it("applies name-carrying patterns only to Studio chrome, not to content", () => {
    expect(translate("Render final", "chrome")).toBe("「final」を書き出す");
    expect(translate("Render final", "content")).toBeNull();
    expect(translate("Close the door", "content")).toBeNull();
    expect(translate("Intro, 1.5 to 3 seconds", "content")).toBeNull();
    expect(translate("Play preview of intro.mp4", "content")).toBeNull();
  });

  it("still translates exact labels and counted patterns in content", () => {
    expect(translate("Timeline", "content")).toBe("タイムライン");
    expect(translate("Renders (3)", "content")).toBe("書き出し履歴（3）");
    expect(translate("4 clips", "content")).toBe("4 個のクリップ");
  });

  it("covers every tooltip label of Studio's toolbars, player and header (HyperFrames 0.8.157)", () => {
    // The `label` of each `Tr` tooltip in Studio's bundle, both states of each toggle.
    const tooltips = [
      "Inspector",
      "Export",
      "Switch to dark theme",
      "Switch to light theme",
      "Capture current frame",
      "Capturing frame…",
      "Render and export this composition",
      "A render is already in progress",
      "Play",
      "Pause",
      "Loop playback",
      "Mute audio",
      "Unmute audio",
      "Playback speed",
      "Enter fullscreen (F)",
      "Exit fullscreen (F)",
      "Shortcuts and tools",
      "Jump to frame",
      "Switch to frame display",
      "Switch to time display",
      "Clear in-point",
      "Clear out-point",
      "Zoom in",
      "Zoom out",
      "Fit timeline to width",
      "Show audio meters",
      "Hide audio meters",
      "Ripple on — keeps the main track gapless",
      "Ripple off — deleting a main-track clip leaves a gap",
      "Snapping on (N)",
      "Snapping off (N)",
      "Linked Selection on — a click selects both halves (⌥-click for one)",
      "Linked Selection off — a click selects one clip",
      "Auto-record manual edits as keyframes (click to turn off)",
      "Manual edits will not be recorded as keyframes (click to turn on)",
      "Hide thumbnails — labels only",
      "Show thumbnails — posters stay visible; richer previews appear on interaction",
      "Split at playhead (S)",
      "Move the playhead inside the clip to split",
      "Select a clip to split",
      "Add beat at playhead",
      "A beat already exists at the playhead",
      "Add a music track with beat analysis to place beats",
      "Add keyframe at playhead (K)",
      "Remove keyframe at playhead (K)",
      "Add keyframe at playhead, extends animation (K)",
      "Add keyframe (K)",
      "Select an animated element to add keyframes",
      "Motion path endpoints cannot be removed",
      "Extend motion path to playhead (K)",
      "Add waypoint to motion path (K)",
      "Remove waypoint from motion path (K)",
      "Delete render file",
      "Hide finished renders from this list (files stay on disk)",
      "Download",
      "Available when the render finishes",
      "Automate",
      "Automated",
      "Render intro",
      "Undo (Cmd+Z)",
      "Redo (Ctrl+Shift+Z)",
    ];
    expect(tooltips.filter((label) => translate(label, "chrome") === null)).toEqual([]);
    expect(translate("Hide audio meters")).toBe("音量メーターを隠す");
    expect(translate("Undo Split clip at playhead (Cmd+Z)")).toBe(
      "元に戻す：再生位置でクリップを分割（Cmd+Z）",
    );
  });
});
