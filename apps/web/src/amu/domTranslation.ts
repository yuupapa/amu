import { japaneseUiText } from "../uiText.ja";
import { japaneseUiTextV2 } from "./uiText.v2.ja";
import { rebrandUiText } from "../uiText";

/**
 * Amu shows the app in Japanese by translating copy as it reaches the page,
 * instead of wrapping every string in the upstream components. Upstream
 * changes then merge without touching thousands of call sites.
 *
 * Only exact dictionary entries and "{0}" templates are replaced, and never
 * inside conversation text, code, editors or other user content. The English
 * a component rendered is remembered, so React can keep updating the node.
 */

const ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&apos;": "'",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&amp;": "&",
  "&nbsp;": " ",
  "&lt;": "<",
  "&gt;": ">",
};

export function normalizeUiKey(text: string): string {
  return text
    .replace(/&(?:quot|apos|rsquo|lsquo|ldquo|rdquo|amp|nbsp|lt|gt);/g, (e) => ENTITIES[e] ?? e)
    .replace(/[\s ]+/g, " ")
    .trim();
}

type Template = {
  readonly pattern: RegExp;
  readonly translated: string;
  /** Longest fixed part, checked with `includes` before running the pattern. */
  readonly anchor: string;
};

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTables(dictionary: Readonly<Record<string, string>>) {
  const exact = new Map<string, string>();
  const templates: Template[] = [];
  for (const [english, japanese] of Object.entries(dictionary)) {
    const key = normalizeUiKey(english);
    if (key.length === 0) continue;
    if (/\{\d+\}/.test(key)) {
      const parts = key.split(/\{(\d+)\}/);
      let source = "^";
      let anchor = "";
      const order: number[] = [];
      for (let index = 0; index < parts.length; index += 2) {
        const part = parts[index] ?? "";
        if (part.trim().length > anchor.length) anchor = part.trim();
      }
      // A short fixed part ("{0}d") would match ordinary words ("Add"), so
      // such templates take numbers only.
      const timeLike = /^\{\d+\}\s?[a-z]{1,3}( ago)?$/.test(key);
      const value = anchor.length < 4 || timeLike ? "(\\d+(?:[.,]\\d+)?)" : "(.+?)";
      parts.forEach((part, index) => {
        if (index % 2 === 0) {
          source += escapeRegExp(part);
        } else {
          order.push(Number(part));
          source += value;
        }
      });
      source += "$";
      // Captured groups are numbered in order of appearance; map them back to {n}.
      let translated = japanese;
      translated = translated.replace(/\{(\d+)\}/g, (_, n: string) => {
        const position = order.indexOf(Number(n));
        return position === -1 ? `{${n}}` : `$${position + 1}`;
      });
      if (anchor.length === 0) continue;
      templates.push({ pattern: new RegExp(source, "s"), translated, anchor });
    } else if (!exact.has(key)) {
      exact.set(key, japanese);
    }
  }
  // Longer anchors are more specific; try them first.
  templates.sort((a, b) => b.anchor.length - a.anchor.length);
  return { exact, templates };
}

let tables: ReturnType<typeof buildTables> | null = null;
function getTables() {
  tables ??= buildTables({ ...japaneseUiTextV2, ...japaneseUiText });
  return tables;
}

/** Japanese for a piece of UI copy, or null when it is not known UI copy. */
export function translateUiCopy(text: string): string | null {
  const key = normalizeUiKey(text);
  if (key.length === 0 || key.length > 400) return null;
  const { exact, templates } = getTables();
  const hit = exact.get(key);
  if (hit !== undefined) return keepEdgeSpace(text, rebrandUiText(hit));
  if (key.includes("\n")) return null;
  for (const template of templates) {
    if (!key.includes(template.anchor)) continue;
    const match = template.pattern.exec(key);
    if (match === null) continue;
    const values = match.slice(1);
    const translated = template.translated.replace(/\$(\d+)/g, (_, n: string) => {
      const value = values[Number(n) - 1] ?? "";
      // Inserted names stay verbatim, but known copy inside them is translated too.
      return exact.get(normalizeUiKey(value)) ?? value;
    });
    return keepEdgeSpace(text, rebrandUiText(translated));
  }
  return null;
}

/** Text outside the dictionary still never shows the upstream app name. */
function rebrandOnly(text: string): string | null {
  if (!/T3/.test(text)) return null;
  const rebranded = rebrandUiText(text);
  return rebranded === text ? null : rebranded;
}

function keepEdgeSpace(original: string, translated: string): string {
  const leading = /^[\s ]*/.exec(original)?.[0] ?? "";
  const trailing = /[\s ]*$/.exec(original)?.[0] ?? "";
  return `${leading}${translated}${trailing}`;
}

/** Translate a string headed outside the page (OS dialogs, menus, notifications). */
export function translateOutgoingText(text: string): string {
  const whole = translateUiCopy(text);
  if (whole !== null) return whole;
  if (text.includes("\n")) {
    return text
      .split("\n")
      .map((line) => translateUiCopy(line) ?? rebrandOnly(line) ?? line)
      .join("\n");
  }
  return rebrandOnly(text) ?? text;
}

// --- Page translation -------------------------------------------------------

/** Subtrees that hold conversation text, code or user input. */
const EXCLUDE_SELECTOR = [
  ".chat-markdown",
  "[data-user-message-body]",
  "pre",
  "code",
  "kbd",
  "textarea",
  "input",
  "select",
  "[contenteditable='']",
  "[contenteditable='true']",
  ".xterm",
  ".monaco-editor",
  ".cm-editor",
  "svg",
  "script",
  "style",
  // Monospace text is data: file names, paths, commands, branches, model ids.
  ".font-mono",
  "[translate='no']",
  ".notranslate",
  "[data-amu-no-translate]",
].join(",");

/** UI inside an excluded subtree that is still app copy. */
const INCLUDE_SELECTOR = [".chat-markdown-codeblock-header", "[data-amu-translate]"].join(",");

const TRANSLATED_ATTRIBUTES = ["title", "placeholder", "aria-label", "alt"] as const;

const originalText = new WeakMap<Text, string>();
const writtenText = new WeakMap<Text, string>();
const originalAttributes = new WeakMap<Element, Map<string, string>>();
const writtenAttributes = new WeakMap<Element, Map<string, string>>();

/** Form fields hold user input, but their placeholder and labels are app copy. */
const FIELD_SELECTOR = "input, textarea, select";

function attributesTranslatable(element: Element): boolean {
  if (element.matches(FIELD_SELECTOR)) return !isExcluded(element.parentElement);
  return !isExcluded(element);
}

function isExcluded(element: Element | null): boolean {
  for (let node = element; node !== null; node = node.parentElement) {
    if (node.matches(INCLUDE_SELECTOR)) return false;
    if (node.matches(EXCLUDE_SELECTOR)) return true;
  }
  return false;
}

function currentOriginal(node: Text): string {
  const value = node.nodeValue ?? "";
  // A value other than ours was written by the app: it is the new English.
  if (writtenText.get(node) !== value) originalText.set(node, value);
  return originalText.get(node) ?? value;
}

function write(node: Text, value: string) {
  writtenText.set(node, value);
  if (node.nodeValue !== value) node.nodeValue = value;
}

/** Elements whose children are only text, like `{count} files`, are read as one string. */
function translateTextGroup(parent: Element): boolean {
  const children = parent.childNodes;
  if (children.length < 2) return false;
  const texts: Text[] = [];
  for (const child of children) {
    if (child.nodeType !== Node.TEXT_NODE) return false;
    texts.push(child as Text);
  }
  const originals = texts.map(currentOriginal);
  const joined = originals.join("");
  const translated = translateUiCopy(joined) ?? rebrandOnly(joined);
  if (translated === null) {
    texts.forEach((node, index) => write(node, originals[index] ?? ""));
    return true;
  }
  texts.forEach((node, index) => write(node, index === 0 ? translated : ""));
  return true;
}

function translateTextNode(node: Text) {
  const parent = node.parentElement;
  if (parent === null || isExcluded(parent)) return;
  if (translateTextGroup(parent)) return;
  const original = currentOriginal(node);
  if (original.trim().length === 0) return;
  write(node, translateUiCopy(original) ?? rebrandOnly(original) ?? original);
}

function translateAttribute(element: Element, name: string) {
  const value = element.getAttribute(name);
  if (value === null || value.trim().length === 0) return;
  let originals = originalAttributes.get(element);
  let written = writtenAttributes.get(element);
  if (originals === undefined) {
    originals = new Map();
    originalAttributes.set(element, originals);
  }
  if (written === undefined) {
    written = new Map();
    writtenAttributes.set(element, written);
  }
  if (written.get(name) !== value) originals.set(name, value);
  const original = originals.get(name) ?? value;
  const next = translateUiCopy(original) ?? rebrandOnly(original) ?? original;
  written.set(name, next);
  if (next !== value) element.setAttribute(name, next);
}

function translateElementAttributes(element: Element) {
  for (const name of TRANSLATED_ATTRIBUTES) {
    if (element.hasAttribute(name)) translateAttribute(element, name);
  }
}

function translateTree(root: Node) {
  if (root.nodeType === Node.TEXT_NODE) {
    translateTextNode(root as Text);
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  const start = root.nodeType === Node.DOCUMENT_NODE ? (root as Document).documentElement : root;
  if (start === null) return;
  if (start.nodeType === Node.ELEMENT_NODE && isExcluded(start as Element)) {
    if (attributesTranslatable(start as Element)) translateElementAttributes(start as Element);
    // An excluded subtree can still hold app copy (a code block's header).
    for (const included of (start as Element).querySelectorAll(INCLUDE_SELECTOR)) {
      translateTree(included);
    }
    return;
  }
  if (start.nodeType === Node.ELEMENT_NODE) translateElementAttributes(start as Element);
  const walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const element = node as Element;
        if (element.matches(INCLUDE_SELECTOR)) return NodeFilter.FILTER_ACCEPT;
        if (element.matches(EXCLUDE_SELECTOR)) {
          if (element.matches(FIELD_SELECTOR) && attributesTranslatable(element)) {
            translateElementAttributes(element);
          }
          for (const included of element.querySelectorAll(INCLUDE_SELECTOR)) {
            translateTree(included);
          }
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) textNodes.push(node as Text);
    else translateElementAttributes(node as Element);
  }
  const groups = new Set<Element>();
  for (const node of textNodes) {
    const parent = node.parentElement;
    if (parent === null) continue;
    if (groups.has(parent)) continue;
    if (translateTextGroup(parent)) {
      groups.add(parent);
      continue;
    }
    const original = currentOriginal(node);
    if (original.trim().length === 0) continue;
    write(node, translateUiCopy(original) ?? rebrandOnly(original) ?? original);
  }
}

let observer: MutationObserver | null = null;

export function startPageTranslation(root: Node = document): () => void {
  if (observer !== null) return () => undefined;
  translateTree(root);
  observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") {
        const node = record.target as Text;
        if (writtenText.get(node) === node.nodeValue) continue;
        translateTextNode(node);
      } else if (record.type === "attributes") {
        const element = record.target as Element;
        const name = record.attributeName;
        if (name === null || !attributesTranslatable(element)) continue;
        if (writtenAttributes.get(element)?.get(name) === element.getAttribute(name)) continue;
        translateAttribute(element, name);
      } else {
        for (const added of record.addedNodes) translateTree(added);
        // Removing a sibling can turn `{count} files` back into one text group.
        if (record.removedNodes.length > 0 && record.target.nodeType === Node.ELEMENT_NODE) {
          const target = record.target as Element;
          if (!isExcluded(target)) translateTextGroup(target);
        }
      }
    }
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...TRANSLATED_ATTRIBUTES],
  });
  return () => {
    observer?.disconnect();
    observer = null;
  };
}
