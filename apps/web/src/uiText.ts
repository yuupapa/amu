import { japaneseUiText } from "./uiText.ja";

const APP_NAME = "Amu";
/**
 * Show this fork's app name. "T3 Connect" (the hosted service) and the GNOME
 * "T3 Code SnapShots" extension keep their real product names.
 */
export function rebrandUiText(text: string): string {
  return text
    .replace(/T3 Code(?! SnapShots| GNOME)/g, APP_NAME)
    .replace(/(?<![A-Za-z0-9_])T3(?![A-Za-z0-9_]| Connect| Code)/g, APP_NAME);
}

const UI_ENTITIES: Record<string, string> = {
  "&quot;": '"',
  "&apos;": "'",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&amp;": "&",
  "&nbsp;": " ",
  "&lt;": "<",
  "&gt;": ">",
};

/** Local fork: display copy only. Unknown provider output and user content stay unchanged. */
export function translateUiText(text: string, language: "ja" | "en"): string {
  return rebrandUiText(translateUiTextRaw(text, language));
}

function translateUiTextRaw(text: string, language: "ja" | "en"): string {
  const key = japaneseUiText[text] === undefined ? text.trim() : text;
  const translated = japaneseUiText[key];
  if (language === "en") {
    if (translated === undefined) return text;

    return text.replace(
      /&(?:quot|apos|rsquo|lsquo|amp|nbsp|lt|gt);/g,
      (entity) => UI_ENTITIES[entity] ?? entity,
    );
  }
  if (text.startsWith("Update Available: "))
    return `更新があります：${text.slice("Update Available: ".length)}`;
  if (translated === undefined) return text;
  return key === text
    ? translated
    : text.slice(0, text.indexOf(key)) + translated + text.slice(text.indexOf(key) + key.length);
}

export const uiLanguage = import.meta.env.VITE_T3_UI_LANGUAGE === "en" ? "en" : "ja";

export function uiText(text: string): string {
  return translateUiText(text, uiLanguage);
}

/** Translate the surrounding copy; inserted names, paths and output are always verbatim. */
export function formatUiText(
  template: string,
  values: readonly unknown[],
  language: "ja" | "en",
): string {
  return translateUiText(template, language).replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const position = Number(index);
    return position < values.length ? String(values[position]) : placeholder;
  });
}

export function uiFormat(template: string, ...values: unknown[]): string {
  return formatUiText(template, values, uiLanguage);
}

const originalCopyByTranslation = new Map<string, string[]>();
for (const [original, translated] of Object.entries(japaneseUiText)) {
  const aliases = originalCopyByTranslation.get(translated) ?? [];
  aliases.push(original);
  originalCopyByTranslation.set(translated, aliases);
}

/** Keep every English alias searchable, including copy sharing one Japanese translation. */
export function originalUiText(text: string): string {
  return originalCopyByTranslation.get(text)?.join(" ") ?? text;
}

export function originalUiTextAliases(text: string): readonly string[] {
  return originalCopyByTranslation.get(text) ?? [text];
}

/** Translate only the unsaved, generated default; saved/user titles remain verbatim. */
export function draftThreadDisplayTitle(title: string, generatedDraft: boolean): string {
  return generatedDraft && title === "New thread" ? uiText(title) : title;
}
