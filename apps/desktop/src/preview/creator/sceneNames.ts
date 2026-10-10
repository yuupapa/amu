/**
 * Short names for the scene buttons of the review tools. Pure: `studioDom.ts`
 * reads each scene host of the assembled preview into a `SceneSource`, and this
 * picks a name a person recognizes (「心柱」「展望台」) from its first heading or
 * caption, falling back to the composition file name.
 */

export type SceneSource = {
  /** `data-composition-file` of the scene host, e.g. `compositions/sc05-shinbashira.html`. */
  readonly file: string | null;
  readonly id: string | null;
  /** Scene start in seconds (`data-start`). */
  readonly start: number;
  /** Heading and caption texts in document order. */
  readonly headings: ReadonlyArray<string>;
  /** Other leaf texts in document order. */
  readonly texts: ReadonlyArray<string>;
};

export type SceneButton = { readonly label: string; readonly start: number };

const MAX_NAME = 12;
const CUT_NAME = 10;
const SEPARATORS = /[、。．！!？?：:・|｜/／—–―〜~「」『』（）()[\]【】]|\s-\s/;
const HAS_WORD = /[A-Za-z぀-ヿ㐀-鿿]/;

/** A short name from a caption, or `null` when it carries no word. */
export const shortSceneName = (text: string): string | null => {
  const flat = text.replace(/\s+/g, " ").trim();
  const head = flat
    .split(SEPARATORS)
    .map((part) => part.trim())
    .find((part) => HAS_WORD.test(part));
  if (head === undefined) return null;
  const chars = [...head];
  return chars.length <= MAX_NAME ? head : `${chars.slice(0, CUT_NAME).join("")}…`;
};

const fileStem = (file: string): string | null => {
  const base = file.split("/").pop() ?? "";
  const stem = base.replace(/\.html?$/i, "").trim();
  return stem === "" ? null : stem;
};

export const sceneLabel = (scene: SceneSource): string => {
  for (const text of [...scene.headings, ...scene.texts]) {
    const name = shortSceneName(text);
    if (name !== null) return name;
  }
  return (scene.file === null ? null : fileStem(scene.file)) ?? scene.id ?? "場面";
};

/** One button per scene, ordered by start; a repeated name gets a counter. */
export const sceneButtons = (scenes: ReadonlyArray<SceneSource>): SceneButton[] => {
  const seen = new Map<string, number>();
  return scenes
    .filter((scene) => Number.isFinite(scene.start) && scene.start >= 0)
    .toSorted((a, b) => a.start - b.start)
    .map((scene) => {
      const base = sceneLabel(scene);
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      return { label: count === 1 ? base : `${base} ${count}`, start: scene.start };
    });
};
