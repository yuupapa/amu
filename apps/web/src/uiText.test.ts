import { describe, expect, it } from "vite-plus/test";
import { originalUiText, translateUiText } from "./uiText";

describe("local Japanese UI", () => {
  it("keeps the original copy available in English", () => {
    expect(translateUiText("Set up T3 Code", "en")).toBe("Set up T3 Code");
  });
  it("localizes onboarding and primary send actions", () => {
    expect(translateUiText("Set up T3 Code", "ja")).toBe("T3 Codeの初期設定");
    expect(translateUiText("Send message", "ja")).toBe("メッセージを送信");
  });
  it("keeps English search terms available for localized labels", () => {
    expect(originalUiText("接続")).toContain("Connections");
    expect(originalUiText("接続")).toContain("Connect");
    expect(originalUiText("画面のフォント")).toBe("Interface font");
  });
  it("preserves unknown output, file paths and model identifiers", () => {
    for (const text of ["/Users/example/Project", "gpt-6", "codex login", "独自のプロジェクト名"]) {
      expect(translateUiText(text, "ja")).toBe(text);
    }
  });
});
