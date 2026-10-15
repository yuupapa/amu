// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// nativeDom captures ResizeObserver at import; jsdom has none.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

import { createTranslator } from "./studioDom.ts";

// Observer callbacks are microtasks queued by the mutation itself, so they run first.
const flush = () => Promise.resolve();

/** Studio's `Tr`: the trigger in `<span class="contents">`, the label in a popup added on hover. */
const studioToolbar = () => {
  document.body.innerHTML = `
    <span class="contents"><button aria-label="Toggle audio meters"></button></span>
    <button aria-label="Panel menu"></button>`;
  const [wrapped, plain] = [...document.querySelectorAll("button")];
  return { wrapped: wrapped!, plain: plain! };
};

let stop: (() => void) | null = null;
afterEach(() => {
  stop?.();
  stop = null;
  document.body.innerHTML = "";
});

describe("createTranslator", () => {
  it("translates Studio's tooltip popup as it appears", async () => {
    studioToolbar();
    const translator = createTranslator(() => false);
    translator.start();
    stop = translator.stop;

    const popup = document.createElement("div");
    popup.innerHTML = `<div role="tooltip">Hide audio meters</div>`;
    document.body.append(popup);
    await flush();
    expect(popup.textContent).toBe("音量メーターを隠す");

    // A label that changes while shown (Show/Hide, Play/Pause) is translated again.
    popup.querySelector("[role=tooltip]")!.firstChild!.nodeValue = "Split at playhead (S)";
    await flush();
    expect(popup.textContent).toBe("再生位置でクリップを分割（S キー）");
  });

  it("gives no native title to a control Studio already shows a tooltip for", async () => {
    const { wrapped, plain } = studioToolbar();
    const translator = createTranslator(() => false);
    translator.start();
    stop = translator.stop;
    await flush();

    expect(wrapped.getAttribute("aria-label")).toBe("音量メーターの表示を切り替え");
    expect(wrapped.hasAttribute("title")).toBe(false);
    // An icon-only button without Studio's tooltip still gets the Japanese one.
    expect(plain.getAttribute("title")).toBe("パネルのメニュー");
  });
});
