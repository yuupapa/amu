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
