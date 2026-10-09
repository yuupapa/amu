/**
 * The message body Amu Creator sends to a thread: a fixed Japanese header, then
 * one line per comment. Pure; the sender pins the result in the send record, so
 * a resend carries exactly the same text.
 */
import type { CreatorPlace } from "@t3tools/contracts";

export interface CreatorMessageItem {
  readonly number: number;
  readonly timeSec: number;
  readonly comment: string;
  readonly place: CreatorPlace | null;
  /** 1-based position among the message's images; null when the comment has none. */
  readonly imageIndex: number | null;
  /** The comment was pinned on an older version of the project than the newest comment. */
  readonly outdated: boolean;
}

export interface CreatorMessageInput {
  readonly projectLabel: string;
  readonly sourceKind: "hyperframes" | "mp4";
  readonly items: ReadonlyArray<CreatorMessageItem>;
}

/** `m:ss.s`, rounded to tenths first so 59.97 becomes `1:00.0`. */
const formatTime = (timeSec: number): string => {
  const tenths = Math.max(0, Math.round(timeSec * 10));
  const minutes = Math.floor(tenths / 600);
  const seconds = ((tenths % 600) / 10).toFixed(1).padStart(4, "0");
  return `${minutes}:${seconds}`;
};

const band = (value: number): 0 | 1 | 2 => (value < 0.4 ? 0 : value > 0.6 ? 2 : 1);

const REGIONS = [
  ["左上", "上", "右上"],
  ["左", "中央", "右"],
  ["左下", "下", "右下"],
] as const;

const sceneOf = (compositionFile: string): string =>
  (compositionFile.split("/").at(-1) ?? compositionFile).replace(/\.html$/, "");

const placeSegments = (place: CreatorPlace | null): string[] => {
  if (place === null) return ["場所なし"];
  const segments: string[] = [];
  if (place.compositionFile !== null) {
    segments.push(`場面 ${sceneOf(place.compositionFile)}`);
    if (place.elementSelector !== null) {
      const label = place.elementLabel === null ? "" : `（${place.elementLabel}）`;
      segments.push(`部品 ${place.compositionFile} ${place.elementSelector}${label}`);
    }
  }
  const region = REGIONS[band(place.y)][band(place.x)];
  segments.push(`位置 ${region}（x ${place.x.toFixed(2)}, y ${place.y.toFixed(2)}）`);
  return segments;
};

const itemLine = (item: CreatorMessageItem): string =>
  [
    `【#${item.number}】${formatTime(item.timeSec)}`,
    ...(item.outdated ? ["古い版で打ったコメント"] : []),
    ...placeSegments(item.place),
    item.imageIndex === null ? "画像なし" : `画像 ${item.imageIndex} 枚目`,
    `指示：${item.comment}`,
  ].join("｜");

export const buildCreatorMessage = (input: CreatorMessageInput): string =>
  [
    `Amu Creator から修正依頼（${input.items.length} 件）`,
    `${input.sourceKind === "mp4" ? "動画" : "プロジェクト"}：${input.projectLabel}`,
    "直したら creator_resolve で各コメントを対応済みにしてください",
    "",
    ...input.items.map(itemLine),
  ].join("\n");
