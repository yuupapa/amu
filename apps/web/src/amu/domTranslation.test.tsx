// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { startPageTranslation, translateOutgoingText, translateUiCopy } from "./domTranslation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("translateUiCopy", () => {
  it("translates exact copy and keeps the spacing around it", () => {
    expect(translateUiCopy("Settings")).toBe("設定");
    expect(translateUiCopy("  Settings ")).toBe("  設定 ");
  });

  it("fills templates and keeps inserted values verbatim", () => {
    expect(translateUiCopy("3 files")).toBe("3ファイル");
    expect(translateUiCopy("src/App.tsx copied")).toBe("src/App.tsxをコピーしました");
  });

  it("matches copy written with JSX entities", () => {
    expect(
      translateUiCopy(
        'Your prompt contains "ultrathink" in the text. Remove it to change this option.',
      ),
    ).not.toBeNull();
  });

  it("fills short time templates with numbers only", () => {
    expect(translateUiCopy("16h ago")).toBe("16時間前");
    expect(translateUiCopy("1d")).toBe("1日");
    expect(translateUiCopy("Settled (3)")).toBe("完了済み（3）");
    // Ordinary words that end like a template stay as they are.
    expect(translateUiCopy("Rapid")).toBeNull();
    expect(translateUiCopy("Bath")).toBeNull();
    expect(translateUiCopy("Hm")).toBeNull();
    expect(translateUiCopy("team ago")).toBeNull();
    expect(translateUiCopy("5m ago")).toBe("5分前");
  });

  it("translates timestamps and relative times from timestampFormat.ts", () => {
    expect(translateUiCopy("yesterday at 20:49")).toBe("昨日 20:49");
    expect(translateUiCopy("tomorrow at 8:05 PM")).toBe("明日 8:05 PM");
    expect(translateUiCopy("just now")).toBe("たった今");
    expect(translateUiCopy("3w")).toBe("3週間");
    expect(translateUiCopy("20:49, 9th October 2026")).toBe("2026年10月9日 20:49");
    expect(translateUiCopy("8:49 PM, 1st May 2025")).toBe("2025年5月1日 8:49 PM");
    // Times inside other copy.
    expect(translateUiCopy("Settled 5m ago")).toBe("完了：5分前");
    expect(translateUiCopy("Snoozed, 3h left")).toBe("スヌーズ中（残り3時間）");
    expect(translateUiCopy("Archived 2d ago · Created just now")).toBe(
      "アーカイブ：2日前・作成：たった今",
    );
    expect(translateUiCopy("Last run 16h ago. 2 MB recovered.")).toBe(
      "前回の実行：16時間前。2 MB を空けました。",
    );
    expect(translateUiCopy("Connected for 4m")).toBe("接続中（4分）");
    // Compound durations.
    expect(translateUiCopy("1m 5s")).toBe("1分5秒");
    expect(translateUiCopy("Expires in 4m 12s")).toBe("あと4分12秒で期限切れ");
    expect(translateUiCopy("Expires in 1d 3h")).toBe("あと1日3時間で期限切れ");
    expect(translateUiCopy("Expires in soon")).toBeNull();
    expect(translateUiCopy("Resets tomorrow at 9:00")).toBe("リセット：明日 9:00");
    expect(translateUiCopy("Next run in 5m")).toBe("次回：5分後");
  });

  it("translates copy found by the 2026-10-11 static check", () => {
    expect(translateUiCopy("Click to steer, Ctrl/⌘-click to queue")).toBe(
      "クリックで割り込み、Ctrl/⌘+クリックでキューに追加",
    );
    expect(translateUiCopy("Delete 3 threads?")).toBe("3 件のスレッドを削除しますか？");
    expect(translateUiCopy("Sent by T3 Code")).toBe("Amu から送信");
    expect(translateUiCopy("Worktree ready")).toBe("作業ツリーを準備しました");
    expect(translateUiCopy("Every 15 min")).toBe("15 分ごと");
  });

  it("translates copy added by the 2026-10-10 upstream sync", () => {
    expect(translateUiCopy("Open on this computer")).toBe("このコンピューターで開く");
    expect(translateUiCopy("Open in Studio Mac's browser")).toBe("Studio Mac のブラウザーで開く");
    expect(translateUiCopy("Open in the environment's browser")).toBe("環境のブラウザーで開く");
    expect(
      translateUiCopy("This connection lacks permission to change settings on Laptop, Server."),
    ).toBe("この接続には、Laptop, Server の設定を変える権限がありません。");
    expect(
      translateUiCopy(
        "This connection lacks permission to change settings on the selected environment.",
      ),
    ).toBe("この接続には、選んだ環境 の設定を変える権限がありません。");
    expect(translateUiCopy("Find in thread")).toBe("スレッド内を検索");
    expect(translateUiCopy("Keep worktrees with local changes")).toBe(
      "ローカルの変更がある作業ツリーを残す",
    );
    expect(translateUiCopy("2 removed, 5 kept, 1 failed")).toBe("削除 2・保持 5・失敗 1");
  });

  it("translates copy upstream reworded", () => {
    expect(
      translateUiCopy(
        "Open linked pull requests first. Otherwise, open Changes for edits to at least 3 files or 50 lines.",
      ),
    ).not.toBeNull();
    // One concatenated description, with or without Shift.
    for (const shortcut of ["⌘", "Ctrl + Shift"]) {
      expect(
        translateUiCopy(
          `Queue follow-ups while the agent runs or steer the current run. Press ${shortcut} + Enter to do the opposite for one message.`,
        ),
      ).toContain(`${shortcut} + Enter`);
    }
    expect(translateUiCopy("Change accent color for Codex")).toBe("Codexのアクセントカラーを変更");
  });

  it("leaves unknown text alone", () => {
    expect(translateUiCopy("refactor the parser")).toBeNull();
  });

  it("never shows the upstream app name in outgoing copy", () => {
    expect(translateOutgoingText("Open T3 Code")).not.toContain("T3");
  });
});

describe("startPageTranslation", () => {
  let host: HTMLDivElement;
  let root: Root;
  let stop: () => void;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    stop = startPageTranslation(document.body);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    stop();
    host.remove();
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("translates copy, attributes and React updates", async () => {
    let setCount: (value: number) => void = () => undefined;
    function View() {
      const [count, set] = useState(1);
      setCount = set;
      return createElement(
        "div",
        null,
        createElement("button", { title: "Search", type: "button" }, "Settings"),
        createElement("span", { id: "files" }, count, " files"),
      );
    }
    await act(async () => root.render(createElement(View)));
    await flush();
    expect(host.querySelector("button")?.textContent).toBe("設定");
    expect(host.querySelector("button")?.getAttribute("title")).toBe("検索");
    expect(host.querySelector("#files")?.textContent).toBe("1ファイル");

    await act(async () => setCount(7));
    await flush();
    expect(host.querySelector("#files")?.textContent).toBe("7ファイル");
  });

  it("follows a label React changes to other copy", async () => {
    let setLabel: (value: string) => void = () => undefined;
    function View() {
      const [label, set] = useState("Copy");
      setLabel = set;
      return createElement("button", { type: "button" }, label);
    }
    await act(async () => root.render(createElement(View)));
    await flush();
    expect(host.textContent).toBe("コピー");
    await act(async () => setLabel("Archive"));
    await flush();
    expect(host.textContent).toBe("アーカイブ");
    await act(async () => setLabel("my own words"));
    await flush();
    expect(host.textContent).toBe("my own words");
  });

  it("does not touch conversation text, user messages, code or inputs", async () => {
    await act(async () =>
      root.render(
        createElement(
          "div",
          null,
          createElement(
            "div",
            { className: "chat-markdown" },
            createElement("p", null, "Settings"),
          ),
          createElement("div", { "data-user-message-body": "true" }, "Archive"),
          createElement("code", null, "Copy"),
          createElement("span", { className: "font-mono", id: "path" }, "Settings"),
          createElement("input", { placeholder: "Search", readOnly: true, value: "Settings" }),
          createElement(
            "div",
            { className: "chat-markdown" },
            createElement("div", { className: "chat-markdown-codeblock-header" }, "Copy"),
          ),
        ),
      ),
    );
    await flush();
    expect(host.querySelector(".chat-markdown p")?.textContent).toBe("Settings");
    expect(host.querySelector("[data-user-message-body]")?.textContent).toBe("Archive");
    expect(host.querySelector("code")?.textContent).toBe("Copy");
    expect(host.querySelector("#path")?.textContent).toBe("Settings");
    // The field's value is the user's, its placeholder is app copy.
    expect(host.querySelector("input")?.getAttribute("placeholder")).toBe("検索");
    expect(host.querySelector("input")?.value).toBe("Settings");
    expect(host.querySelector(".chat-markdown-codeblock-header")?.textContent).toBe("コピー");
  });

  it("does not rebrand the upstream name inside conversation text", async () => {
    await act(async () =>
      root.render(
        createElement(
          "div",
          null,
          createElement("div", { className: "chat-markdown" }, "T3 Code"),
          createElement("span", { id: "ui" }, "Welcome to T3 Code"),
        ),
      ),
    );
    await flush();
    expect(host.querySelector(".chat-markdown")?.textContent).toBe("T3 Code");
    expect(host.querySelector("#ui")?.textContent).not.toContain("T3");
  });
});
