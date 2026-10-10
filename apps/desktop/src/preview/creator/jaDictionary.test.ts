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
});
