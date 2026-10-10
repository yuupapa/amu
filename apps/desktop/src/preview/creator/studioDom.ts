// @effect-diagnostics globalDate:off globalTimers:off - Runs in the guest preload, outside any Effect runtime.
/**
 * Everything the Creator overlay reads from or does to HyperFrames Studio's DOM
 * (verified against Studio 0.8.143 in stage 0):
 * - `<hyperframes-player>` has `currentTime`, `duration`, `playbackRate`,
 *   `pause()` and `seek(t)`, and fires `timeupdate`. Its shadow root holds the
 *   preview iframe, which renders the composition at full size and is scaled
 *   down with CSS.
 * - Scene hosts in the assembled preview carry `data-composition-file` and
 *   `data-start`; the composition root has `data-composition-id`.
 * - The top-left logo is an `<svg aria-label="Hyperframes">`.
 * Not unit-tested (desktop has no DOM test environment); checked live in Task 12.
 */
import { toPageRect, type Rect } from "../creatorGeometry.ts";
import { translate } from "./jaDictionary.ts";
import { NativeMutationObserver } from "./nativeDom.ts";
import type { SceneSource } from "./sceneNames.ts";

type PlayerElement = HTMLElement & {
  currentTime?: number;
  duration?: number;
  playbackRate?: number;
  paused?: boolean;
  pause?: () => void;
  seek?: (timeSec: number) => void;
};

const MAX_FIELD = 200;
const MAX_LABEL = 40;
const SEEK_TOLERANCE_SEC = 0.05;
const SEEK_MAX_FRAMES = 30;
const SCENE_SCAN_NODES = 400;
const TRANSLATED_ATTRIBUTES = ["title", "aria-label", "placeholder"] as const;
const SKIP_TRANSLATION = ".cm-editor, .cm-content, textarea, input, [contenteditable='true']";
/**
 * Studio chrome: controls, menus and tooltips. Name-carrying patterns
 * ("Render <name>") apply only here, so user content such as a caption or a
 * file name that happens to read "Render final" is left alone.
 */
const CHROME_SELECTOR =
  "button, a, label, summary, option, select, [role=button], [role=menu], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=tab], [role=tooltip], [role=option], [role=slider]";
/** Translated nodes remembered for teardown before disconnected ones are dropped. */
const MAX_RECORDED = 5_000;

export const findPlayer = (): PlayerElement | null =>
  document.querySelector<PlayerElement>("hyperframes-player");

export const findLogo = (): Element | null => document.querySelector('[aria-label="Hyperframes"]');

export const previewIframe = (): HTMLIFrameElement | null =>
  findPlayer()?.shadowRoot?.querySelector<HTMLIFrameElement>("iframe") ?? null;

/** The composition document, when it is same-origin and loaded. */
export const compositionDocument = (): Document | null => {
  try {
    return previewIframe()?.contentDocument ?? null;
  } catch {
    return null;
  }
};

const compositionRoot = (doc: Document | null): HTMLElement | null =>
  doc?.querySelector<HTMLElement>("[data-composition-id]") ?? null;

export const currentTime = (): number | null => {
  const value = findPlayer()?.currentTime;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
};

export const duration = (): number => {
  const value = findPlayer()?.duration;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
};

export const isPlaying = (): boolean => findPlayer()?.paused === false;

export const pausePlayer = (): void => {
  findPlayer()?.pause?.();
};

export const seekTo = (timeSec: number): void => {
  findPlayer()?.seek?.(Math.max(0, timeSec));
};

export const playbackRate = (): number => {
  const value = findPlayer()?.playbackRate;
  return typeof value === "number" && Number.isFinite(value) ? value : 1;
};

export const setPlaybackRate = (rate: number): void => {
  const player = findPlayer();
  if (player) player.playbackRate = rate;
};

export const waitFrames = (count: number): Promise<void> =>
  new Promise((resolve) => {
    const step = (left: number) => {
      if (left <= 0) resolve();
      else requestAnimationFrame(() => step(left - 1));
    };
    step(count);
  });

/**
 * Seeks and resolves once the player reports the time (its seek may go through
 * a postMessage to the iframe), or after about half a second.
 */
export const seekAndSettle = async (timeSec: number): Promise<void> => {
  seekTo(timeSec);
  for (let frame = 0; frame < SEEK_MAX_FRAMES; frame += 1) {
    const now = currentTime();
    if (now !== null && Math.abs(now - timeSec) <= SEEK_TOLERANCE_SEC) return;
    await waitFrames(1);
  }
};

const iframeScale = (iframe: HTMLIFrameElement, box: DOMRect) => ({
  x: iframe.clientWidth > 0 ? box.width / iframe.clientWidth : 1,
  y: iframe.clientHeight > 0 ? box.height / iframe.clientHeight : 1,
});

/** The composition's rect in this page's viewport CSS px (iframe offset and CSS scale applied). */
export const compositionRect = (): Rect | null => {
  const iframe = previewIframe();
  const root = compositionRoot(compositionDocument());
  if (!iframe || !root) return null;
  const box = iframe.getBoundingClientRect();
  const inner = root.getBoundingClientRect();
  const scale = iframeScale(iframe, box);
  const rect = toPageRect({
    compInIframe: { x: inner.x, y: inner.y, width: inner.width, height: inner.height },
    iframeInPage: { x: box.x, y: box.y, width: box.width, height: box.height },
    iframeScaleX: scale.x,
    iframeScaleY: scale.y,
  });
  return rect.width > 0 && rect.height > 0 ? rect : null;
};

/** A point from an event inside the composition iframe, in this page's viewport px. */
export const iframePointToViewport = (clientX: number, clientY: number) => {
  const iframe = previewIframe();
  if (!iframe) return null;
  const box = iframe.getBoundingClientRect();
  const scale = iframeScale(iframe, box);
  return { x: box.x + clientX * scale.x, y: box.y + clientY * scale.y };
};

const flatText = (value: string | null | undefined): string =>
  (value ?? "").replace(/\s+/g, " ").trim();

const clip = (value: string, max: number): string => [...value].slice(0, max).join("");

/** Same shape rule as the contract's `CreatorCompositionFile`; anything else becomes null. */
const compositionFileOf = (value: string | null): string | null => {
  if (value === null || value === "" || value.length > MAX_FIELD) return null;
  if (value.includes("..") || value.startsWith("/") || value.includes("\\")) return null;
  if ([...value].some((char) => char.charCodeAt(0) < 0x20)) return null;
  return value.endsWith(".html") ? value : null;
};

const describe = (element: Element): string => {
  const tag = element.tagName.toLowerCase();
  const firstClass = [...element.classList].find((name) => /^[A-Za-z_][\w-]*$/.test(name));
  return firstClass === undefined ? tag : `${tag}.${firstClass}`;
};

const selectorOf = (element: Element): string => {
  if (element.id !== "") return clip(`#${CSS.escape(element.id)}`, MAX_FIELD);
  const anchor = element.parentElement?.closest("[id]");
  const own = describe(element);
  return clip(anchor ? `#${CSS.escape(anchor.id)} ${own}` : own, MAX_FIELD);
};

const labelOf = (element: Element): string | null => {
  const text = flatText(element.textContent);
  if (text !== "" && text.length <= 200) return clip(text, MAX_LABEL);
  const named = flatText(element.getAttribute("aria-label") ?? element.getAttribute("alt"));
  return named === "" ? null : clip(named, MAX_LABEL);
};

/** What is under a normalized point of the composition: scene file, a short selector and a label. */
export const elementAt = (
  nx: number,
  ny: number,
): {
  compositionFile: string | null;
  elementSelector: string | null;
  elementLabel: string | null;
} => {
  const doc = compositionDocument();
  const root = compositionRoot(doc);
  if (!doc || !root) return { compositionFile: null, elementSelector: null, elementLabel: null };
  const box = root.getBoundingClientRect();
  const hit = doc.elementFromPoint(box.x + nx * box.width, box.y + ny * box.height);
  if (!hit || hit === doc.documentElement || hit === doc.body) {
    return { compositionFile: null, elementSelector: null, elementLabel: null };
  }
  const host = hit.closest("[data-composition-file]");
  return {
    compositionFile: compositionFileOf(host?.getAttribute("data-composition-file") ?? null),
    elementSelector: selectorOf(hit),
    elementLabel: labelOf(hit),
  };
};

const HEADING_SELECTOR =
  "h1, h2, h3, h4, [data-caption], [class*='caption' i], [class*='title' i], [class*='heading' i]";

/** Scene hosts of the assembled preview with the texts `sceneNames.ts` picks a name from. */
export const readScenes = (): SceneSource[] => {
  const doc = compositionDocument();
  if (!doc) return [];
  return [...doc.querySelectorAll<HTMLElement>("[data-composition-file]")].map((host) => {
    const headings = [...host.querySelectorAll(HEADING_SELECTOR)]
      .slice(0, 5)
      .map((node) => flatText(node.textContent))
      .filter((text) => text !== "");
    const texts: string[] = [];
    const walker = doc.createTreeWalker(host, NodeFilter.SHOW_ELEMENT);
    for (let seen = 0; seen < SCENE_SCAN_NODES && texts.length < 20; seen += 1) {
      const node = walker.nextNode();
      if (node === null) break;
      // `instanceof Element` is false across the iframe's realm; check the node type.
      if (node.nodeType === Node.ELEMENT_NODE && (node as Element).childElementCount === 0) {
        const text = flatText(node.textContent);
        if (text !== "") texts.push(text);
      }
    }
    return {
      file: host.getAttribute("data-composition-file"),
      id: host.id === "" ? null : host.id,
      start: Number(host.getAttribute("data-start") ?? "0"),
      headings,
      texts,
    };
  });
};

/** Translates Studio text and remembers originals so teardown can put them back. */
export const createTranslator = (isOurs: (node: Node) => boolean) => {
  const texts = new Map<Text, { original: string; translated: string }>();
  const attributes = new Map<
    Element,
    Map<string, { original: string | null; translated: string }>
  >();
  const prune = () => {
    if (texts.size > MAX_RECORDED) {
      for (const node of texts.keys()) if (!node.isConnected) texts.delete(node);
    }
    if (attributes.size > MAX_RECORDED) {
      for (const node of attributes.keys()) if (!node.isConnected) attributes.delete(node);
    }
  };
  const setAttribute = (element: Element, name: string, value: string) => {
    let recorded = attributes.get(element);
    if (recorded === undefined) {
      recorded = new Map();
      attributes.set(element, recorded);
    }
    const before = recorded.get(name);
    recorded.set(name, {
      original: before === undefined ? element.getAttribute(name) : before.original,
      translated: value,
    });
    element.setAttribute(name, value);
  };
  const doText = (node: Text) => {
    const parent = node.parentElement;
    if (!parent || parent.closest(SKIP_TRANSLATION) || isOurs(parent)) return;
    const value = node.nodeValue ?? "";
    const next = translate(value, parent.closest(CHROME_SELECTOR) ? "chrome" : "content");
    if (next === null || next === value) return;
    const before = texts.get(node);
    texts.set(node, { original: before?.original ?? value, translated: next });
    node.nodeValue = next;
  };
  const doElement = (element: Element) => {
    if (element.closest(".cm-editor") || isOurs(element)) return;
    for (const name of TRANSLATED_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (!value) continue;
      // title, aria-label and placeholder describe controls: always chrome.
      const next = translate(value, "chrome");
      if (next !== null && next !== value) setAttribute(element, name, next);
    }
    // Icon-only buttons get the Japanese label as a tooltip too.
    if (
      !element.hasAttribute("title") &&
      element.matches("button, [role=button], [role=tab], a, [role=slider]")
    ) {
      const label = element.getAttribute("aria-label");
      if (label && /[ぁ-んァ-ン一-龥]/.test(label)) setAttribute(element, "title", label);
    }
  };
  const walk = (root: Node) => {
    if (root.nodeType === Node.TEXT_NODE) return doText(root as Text);
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    doElement(root as Element);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.nodeType === Node.TEXT_NODE) doText(node as Text);
      else doElement(node as Element);
    }
  };
  const observer = new NativeMutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "characterData") doText(mutation.target as Text);
      else if (mutation.type === "attributes") doElement(mutation.target as Element);
      else mutation.addedNodes.forEach(walk);
    }
    prune();
  });
  return {
    start: () => {
      if (!document.body) return false;
      walk(document.body);
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: [...TRANSLATED_ATTRIBUTES],
      });
      return true;
    },
    /** Puts back every original that still shows our translation. */
    stop: () => {
      observer.disconnect();
      for (const [node, entry] of texts) {
        if (node.isConnected && node.nodeValue === entry.translated)
          node.nodeValue = entry.original;
      }
      for (const [element, recorded] of attributes) {
        if (!element.isConnected) continue;
        for (const [name, entry] of recorded) {
          if (element.getAttribute(name) !== entry.translated) continue;
          if (entry.original === null) element.removeAttribute(name);
          else element.setAttribute(name, entry.original);
        }
      }
      texts.clear();
      attributes.clear();
    },
  };
};

/** `brand` ("Amu Creator") in place of the HyperFrames logo and in the page title. */
export const createBranding = (brand: string) => {
  const originalTitle = document.title;
  const brands = new Set<HTMLSpanElement>();
  const hiddenLogos = new Map<HTMLElement | SVGElement, string>();
  const applyTitle = () => {
    if (document.title !== brand) document.title = brand;
  };
  const titleObserver = new NativeMutationObserver(applyTitle);
  const applyLogo = (): boolean => {
    const logo = findLogo();
    if (!(logo instanceof HTMLElement || logo instanceof SVGElement)) return false;
    if (hiddenLogos.has(logo)) return true;
    // Studio re-rendered the logo next to a label we already placed: reuse it.
    const previous = logo.previousElementSibling;
    if (previous instanceof HTMLSpanElement && brands.has(previous)) {
      hiddenLogos.set(logo, logo.style.display);
      logo.style.display = "none";
      return true;
    }
    const label = document.createElement("span");
    label.textContent = brand;
    label.setAttribute("data-amu-creator-brand", "");
    label.style.cssText =
      "font:800 15px/28px system-ui,-apple-system,sans-serif;color:#39d0b8;white-space:nowrap;letter-spacing:.02em";
    logo.before(label);
    brands.add(label);
    hiddenLogos.set(logo, logo.style.display);
    logo.style.display = "none";
    return true;
  };
  return {
    start: () => {
      applyTitle();
      titleObserver.observe(document.head ?? document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    },
    /** Re-applies after Studio re-renders; false when the logo is missing. */
    refresh: (): boolean => {
      applyTitle();
      for (const logo of hiddenLogos.keys()) if (!logo.isConnected) hiddenLogos.delete(logo);
      const found = applyLogo();
      // A label whose logo went away is removed.
      for (const label of brands) {
        const next = label.nextElementSibling;
        const kept = next instanceof HTMLElement || next instanceof SVGElement;
        if (!label.isConnected || !kept || !hiddenLogos.has(next)) {
          label.remove();
          brands.delete(label);
        }
      }
      return found;
    },
    stop: () => {
      titleObserver.disconnect();
      for (const label of brands) label.remove();
      for (const [logo, display] of hiddenLogos) logo.style.display = display;
      brands.clear();
      hiddenLogos.clear();
      if (document.title === brand) document.title = originalTitle;
    },
  };
};
