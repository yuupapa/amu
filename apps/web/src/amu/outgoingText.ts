import type { ContextMenuItem } from "@t3tools/contracts";

import { uiLanguage } from "../uiText";
import { translateOutgoingText as translateToJapanese, translateUiCopy } from "./domTranslation";

/** Copy that leaves the page (OS notifications, native menus) is translated here. */
export function translateOutgoingText(text: string): string {
  return uiLanguage === "ja" ? translateToJapanese(text) : text;
}

export function translateMenuItems<T extends string>(
  items: readonly ContextMenuItem<T>[],
): ContextMenuItem<T>[] {
  return items.map((item) => ({
    ...item,
    label: translateOutgoingText(item.label),
    ...(item.children ? { children: translateMenuItems(item.children) } : {}),
  }));
}

/** Search terms plus their Japanese, so a label can be found by what the page shows. */
export function withJapaneseAliases(terms: readonly string[]): string[] {
  if (uiLanguage !== "ja") return [...terms];
  const aliases: string[] = [];
  for (const term of terms) {
    const translated = translateUiCopy(term);
    if (translated !== null) aliases.push(translated);
  }
  return aliases.length === 0 ? [...terms] : [...terms, ...aliases];
}
