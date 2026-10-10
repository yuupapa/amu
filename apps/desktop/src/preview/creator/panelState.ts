/**
 * What the 修正コメント panel shows for the state the renderer pushes on
 * `creator:state`. Pure, so labels and enabled actions are tested in node.
 *
 * The pushed `state` is a `CreatorSnapshot` (`comments`, `proposals`) plus
 * optional fields the renderer may add:
 * - `projectRevision`: the project's current version, for 「古い版」
 * - `draftKeys`: `requestId -> commentId` for drafts created from `creator:draft`,
 *   so the panel can bind its placeholder card to the saved comment
 * - `notice`: a short message to show (e.g. why a save was refused)
 */
import type { CreatorComment, CreatorPlace, CreatorProposal } from "@t3tools/contracts";

import type { CaptureSpec, Point } from "./captureClient.ts";

export type PanelState = {
  readonly comments: ReadonlyArray<CreatorComment>;
  readonly proposals: ReadonlyArray<CreatorProposal>;
  readonly projectRevision: string | null;
  readonly draftKeys: Readonly<Record<string, string>>;
  readonly notice: string | null;
};

const MAX_PROPOSAL_ITEMS = 30;
const STATUSES = new Set(["draft", "proposed", "sending", "sent", "resolved", "confirmed"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isNullableString = (value: unknown): boolean => value === null || typeof value === "string";
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isUnit = (value: unknown): boolean => isFiniteNumber(value) && value >= 0 && value <= 1;

const isPlace = (value: unknown): boolean =>
  value === null ||
  (isRecord(value) &&
    isUnit(value["x"]) &&
    isUnit(value["y"]) &&
    isNullableString(value["compositionFile"]) &&
    isNullableString(value["elementSelector"]) &&
    isNullableString(value["elementLabel"]));

const isShot = (value: unknown): boolean =>
  value === null ||
  (isRecord(value) && typeof value["commentId"] === "string" && isFiniteNumber(value["revision"]));

const isSentVersion = (value: unknown): boolean =>
  value === null ||
  (isRecord(value) &&
    typeof value["comment"] === "string" &&
    isFiniteNumber(value["revision"]) &&
    isPlace(value["place"] ?? null) &&
    isShot(value["shot"] ?? null));

const isComment = (value: unknown): value is CreatorComment =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  isFiniteNumber(value["number"]) &&
  isFiniteNumber(value["timeSec"]) &&
  typeof value["comment"] === "string" &&
  isFiniteNumber(value["revision"]) &&
  typeof value["status"] === "string" &&
  STATUSES.has(value["status"]) &&
  typeof value["projectRevision"] === "string" &&
  isPlace(value["place"]) &&
  isShot(value["shot"]) &&
  isSentVersion(value["sentVersion"]) &&
  isNullableString(value["resolvedNote"] ?? null);

const SEND_STATES = new Set(["sending", "accepted", "rejected", "conflict", "stuck", "halted"]);

const isSendRecord = (value: unknown): boolean =>
  value === null ||
  (isRecord(value) &&
    typeof value["state"] === "string" &&
    SEND_STATES.has(value["state"]) &&
    isFiniteNumber(value["attempts"]));

const isProposal = (value: unknown): value is CreatorProposal =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  Array.isArray(value["items"]) &&
  value["items"].every((item) => isRecord(item) && typeof item["commentId"] === "string") &&
  isSendRecord(value["send"] ?? null);

/** The pushed state, or `null` when it is not one. Malformed entries are skipped. */
export const readPanelState = (raw: unknown): PanelState | null => {
  if (!isRecord(raw) || !Array.isArray(raw["comments"])) return null;
  const proposals = Array.isArray(raw["proposals"]) ? raw["proposals"] : [];
  const draftKeys: Record<string, string> = {};
  if (isRecord(raw["draftKeys"])) {
    for (const [key, value] of Object.entries(raw["draftKeys"])) {
      if (typeof value === "string") draftKeys[key] = value;
    }
  }
  return {
    comments: raw["comments"].filter(isComment),
    proposals: proposals.filter(isProposal),
    projectRevision: typeof raw["projectRevision"] === "string" ? raw["projectRevision"] : null,
    draftKeys,
    notice: typeof raw["notice"] === "string" ? raw["notice"].slice(0, 200) : null,
  };
};

/** 「1分16秒」, or 「9秒」 under a minute. */
export const formatTime = (sec: number): string => {
  const total = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0 ? `${seconds}秒` : `${minutes}分${String(seconds).padStart(2, "0")}秒`;
};

/** Sent before and edited since: the AI has not seen the current text. */
export const needsResend = (comment: CreatorComment): boolean =>
  comment.sentVersion !== null && comment.sentVersion.revision !== comment.revision;

const holdingProposal = (comment: CreatorComment, proposals: ReadonlyArray<CreatorProposal>) =>
  proposals.find((proposal) => proposal.items.some((item) => item.commentId === comment.id));

const baseLabel = (comment: CreatorComment, proposals: ReadonlyArray<CreatorProposal>): string => {
  switch (comment.status) {
    case "draft":
      return needsResend(comment) ? "再送が必要" : "未送信";
    case "proposed":
      return "確認待ち";
    case "sending": {
      const send = holdingProposal(comment, proposals)?.send ?? null;
      if (send === null) return "送信中";
      if (send.state === "conflict" || send.state === "stuck" || send.state === "halted") {
        return "送信の確認が必要";
      }
      return send.attempts > 0 ? "送信を確認中" : "送信中";
    }
    case "sent":
      return needsResend(comment) ? "再送が必要" : "送信済み";
    case "resolved":
      return needsResend(comment) ? "再送が必要" : "対応済み";
    case "confirmed":
      return needsResend(comment) ? "再送が必要" : "確認済み";
  }
};

export const commentStatusLabel = (
  comment: CreatorComment,
  proposals: ReadonlyArray<CreatorProposal>,
  currentProjectRevision: string | null,
): string => {
  const label = baseLabel(comment, proposals);
  const old = currentProjectRevision !== null && comment.projectRevision !== currentProjectRevision;
  return old ? `${label}・古い版` : label;
};

export type CommentActions = {
  readonly sendOne: boolean;
  readonly remove: boolean;
  /** The pending proposal 「取り消し」 cancels. */
  readonly cancelProposalId: string | null;
  readonly confirm: boolean;
};

const isSendable = (comment: CreatorComment): boolean =>
  comment.status === "draft" ||
  ((comment.status === "sent" || comment.status === "resolved" || comment.status === "confirmed") &&
    needsResend(comment));

export const commentActions = (
  comment: CreatorComment,
  proposals: ReadonlyArray<CreatorProposal>,
): CommentActions => {
  const holder = comment.status === "proposed" ? holdingProposal(comment, proposals) : undefined;
  return {
    sendOne: isSendable(comment),
    remove: comment.status !== "sending",
    cancelProposalId: holder !== undefined && holder.send === null ? holder.id : null,
    confirm: comment.status === "resolved",
  };
};

/** What 「まとめて送る」 proposes: sendable comments, oldest first, at most 30. */
export const sendableIds = (comments: ReadonlyArray<CreatorComment>): string[] =>
  comments
    .filter(isSendable)
    .toSorted((a, b) => a.number - b.number)
    .slice(0, MAX_PROPOSAL_ITEMS)
    .map((comment) => comment.id);

export type PlaceholderRef = {
  readonly requestId: string;
  readonly timeSec: number;
  /** The text sent with `creator:draft`, or `null` while not sent. */
  readonly sentText: string | null;
};

/**
 * Which saved comment each sent placeholder became: the renderer's `draftKeys`
 * first, otherwise a comment the panel had not seen before with the same time
 * and text. A comment binds to at most one placeholder.
 */
export const bindPlaceholders = (
  placeholders: ReadonlyArray<PlaceholderRef>,
  knownIds: ReadonlySet<string>,
  state: Pick<PanelState, "comments" | "draftKeys">,
): Map<string, string> => {
  const bound = new Map<string, string>();
  const taken = new Set<string>();
  const ids = new Set<string>(state.comments.map((comment) => comment.id));
  for (const placeholder of placeholders) {
    if (placeholder.sentText === null) continue;
    const keyed = state.draftKeys[placeholder.requestId];
    if (keyed !== undefined && ids.has(keyed) && !taken.has(keyed)) {
      bound.set(placeholder.requestId, keyed);
      taken.add(keyed);
    }
  }
  for (const placeholder of placeholders) {
    if (placeholder.sentText === null || bound.has(placeholder.requestId)) continue;
    const match = state.comments.find(
      (comment) =>
        !knownIds.has(comment.id) &&
        !taken.has(comment.id) &&
        Math.abs(comment.timeSec - placeholder.timeSec) < 0.001 &&
        comment.comment === placeholder.sentText,
    );
    if (match !== undefined) {
      bound.set(placeholder.requestId, match.id);
      taken.add(match.id);
    }
  }
  return bound;
};

export type EditDecision = "clear" | "resend" | "wait";

/**
 * What to do with a comment's unsent local text when a state arrives:
 * `clear` once the server shows that exact text; `resend` when it is not in
 * flight, or a newer revision arrived without it (another change got in first
 * and the update was refused); otherwise `wait`. Empty text is never sent.
 */
export const reconcileEdit = (input: {
  readonly local: string;
  readonly serverText: string;
  /** The revision the server shows now. */
  readonly serverRevision: number;
  /** The revision the in-flight update was sent against, or `null` when none is in flight. */
  readonly sentAgainst: number | null;
}): EditDecision => {
  const text = input.local.trim();
  if (text === input.serverText) return "clear";
  if (text === "") return "wait";
  if (input.sentAgainst === null || input.serverRevision > input.sentAgainst) return "resend";
  return "wait";
};

/**
 * The `creator:place` payload and its capture request. Both carry the same
 * `requestId`: the renderer attaches the shot only to the place it belongs to,
 * and drops it when that place was refused.
 */
export const placeMessages = (input: {
  readonly requestId: string;
  readonly comment: { readonly id: string; readonly revision: number; readonly timeSec: number };
  readonly place: CreatorPlace;
  readonly pin: Point;
}): { readonly place: Record<string, unknown>; readonly capture: CaptureSpec } => ({
  place: {
    requestId: input.requestId,
    commentId: input.comment.id,
    expectedRevision: input.comment.revision,
    place: input.place,
  },
  capture: {
    requestId: input.requestId,
    purpose: "place",
    timeSec: input.comment.timeSec,
    commentId: input.comment.id,
    place: input.place,
    pin: input.pin,
  },
});

/** Where a card's capture stands, as the panel tracks it. */
export type CardCapture = "pending" | "ok" | "failed" | null;

export type ShotView = {
  /** The line next to the card's time; empty when there is nothing to say. */
  readonly label: string;
  /** Show 「撮り直す」: the image is from the previous place and can be taken again. */
  readonly retake: boolean;
};

const STALE_SHOT = "画像は前の場所のままです";

/**
 * What a card says about its image. A capture in progress first; then an image
 * left from before the place moved (`shotStale`), with a retake; then
 * 「画像なし」 for a failed capture or a comment without any image.
 */
export const shotView = (comment: CreatorComment | undefined, capture: CardCapture): ShotView => {
  if (capture === "pending") return { label: "撮影中…", retake: false };
  if (comment !== undefined && comment.shot !== null && comment.shotStale === true) {
    return {
      label: STALE_SHOT,
      retake: comment.place !== null && comment.status !== "sending",
    };
  }
  if (capture === "failed" || (capture === null && comment?.shot === null)) {
    return { label: "画像なし", retake: false };
  }
  return { label: "", retake: false };
};

/**
 * 「撮り直す」: the stored place sent again with a capture pinned at its stored
 * point, through the same place + capture pair as a new place, so the renderer
 * pairs the shot by `requestId` and the server clears `shotStale` when it lands.
 */
export const retakeMessages = (requestId: string, comment: CreatorComment) =>
  comment.place === null
    ? null
    : placeMessages({
        requestId,
        comment: { id: comment.id, revision: comment.revision, timeSec: comment.timeSec },
        place: comment.place,
        pin: { x: comment.place.x, y: comment.place.y },
      });

/** Place mode for a comment ends by itself once the comment is gone or being sent. */
export const canKeepPlacing = (comment: CreatorComment | undefined): boolean =>
  comment !== undefined && comment.status !== "sending";

/**
 * What the panel says while edits are unsaved, given the unsent texts in
 * question (one card's, or every card's). An emptied card is never sent, as
 * that would keep the text the user deleted, so it asks for a rewrite or a
 * delete instead of a 「保存中…」 that never ends.
 */
export const unsavedLabels = (edits: Iterable<string>) => {
  for (const edit of edits) {
    if (edit.trim() === "") {
      return {
        card: "指示が空です。書き直すか、カードを削除してください",
        sendAll: "空のカードがあります",
        notice: "指示が空のカードは送れません。書き直すか、削除してください",
      };
    }
  }
  return { card: "保存中…", sendAll: "保存中…", notice: "保存が終わるまでお待ちください" };
};
