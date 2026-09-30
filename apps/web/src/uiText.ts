import { japaneseUiText } from "./uiText.ja";

/** Local fork: display copy only. Unknown provider output and user content stay unchanged. */
export function translateUiText(text: string, language: "ja" | "en"): string {
  return language === "ja" ? (japaneseUiText[text] ?? text) : text;
}

export const uiLanguage = import.meta.env.VITE_T3_UI_LANGUAGE === "en" ? "en" : "ja";

export function uiText(text: string): string {
  return translateUiText(text, uiLanguage);
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
