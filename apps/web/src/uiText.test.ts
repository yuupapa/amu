import { describe, expect, it } from "vite-plus/test";
import { draftThreadDisplayTitle, formatUiText, originalUiText, translateUiText } from "./uiText";

describe("local Japanese UI", () => {
  it("keeps the original copy available in English", () => {
    expect(translateUiText("Set up T3 Code", "en")).toBe("Set up Amu");
  });
  it("localizes onboarding and primary send actions", () => {
    expect(translateUiText("Set up T3 Code", "ja")).toBe("Amuの初期設定");
    expect(translateUiText("Send message", "ja")).toBe("メッセージを送信");
  });
  it("keeps English search terms available for localized labels", () => {
    expect(originalUiText("接続")).toContain("Connections");
    expect(originalUiText("接続")).toContain("Connect");
    expect(originalUiText("画面のフォント")).toBe("Interface font");
  });
  it("localizes only the generated draft title and preserves saved or custom titles", () => {
    expect(draftThreadDisplayTitle("New thread", true)).toBe(
      translateUiText("New thread", import.meta.env.VITE_T3_UI_LANGUAGE === "en" ? "en" : "ja"),
    );
    expect(draftThreadDisplayTitle("New thread", false)).toBe("New thread");
    expect(draftThreadDisplayTitle("My New thread", true)).toBe("My New thread");
  });
  it("preserves unknown output, file paths and model identifiers", () => {
    for (const text of ["/Users/example/Project", "gpt-6", "codex login", "独自のプロジェクト名"]) {
      expect(translateUiText(text, "ja")).toBe(text);
    }
  });
  it("formats translated copy without translating or reparsing inserted content", () => {
    expect(formatUiText("Failed to copy {0}", ["Settings {1}"], "ja")).toBe(
      "Settings {1}をコピーできませんでした",
    );
    expect(formatUiText("Failed to copy {0}", ["Settings {1}"], "en")).toBe(
      "Failed to copy Settings {1}",
    );
    expect(formatUiText("Comparing {0} against {1}", ["/tmp/Connect", "gpt-6"], "ja")).toBe(
      "/tmp/Connectとgpt-6を比較中",
    );
    expect(formatUiText("{0} {1}", [0], "en")).toBe("0 {1}");
  });
  it("preserves JSX entities in English display copy while keeping unknown content verbatim", () => {
    expect(translateUiText("Unknown &quot;provider&quot; output", "en")).toBe(
      "Unknown &quot;provider&quot; output",
    );
    expect(translateUiText("Don&apos;t show this again", "en")).toBe("Don't show this again");
  });
  it("keeps inline spacing around translated display copy", () => {
    expect(translateUiText(" saving ", "en")).toBe(" saving ");
    expect(translateUiText(" saving ", "ja")).toBe(" 保存中 ");
    expect(translateUiText(" unknown output ", "ja")).toBe(" unknown output ");
  });
  it("shows the app name but keeps real product names", () => {
    expect(translateUiText("Quit T3 Code", "ja")).toBe("Amuを終了");
    expect(translateUiText("T3 Connect settings", "ja")).toBe("T3 Connectの設定");
    expect(translateUiText("T3 system footprint", "ja")).toBe("Amuのシステム使用量");
  });
});
