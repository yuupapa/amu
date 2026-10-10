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
import type { CreatorComment, CreatorProposal } from "@t3tools/contracts";

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

const isComment = (value: unknown): value is CreatorComment =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["number"] === "number" &&
  typeof value["timeSec"] === "number" &&
  Number.isFinite(value["timeSec"]) &&
  typeof value["comment"] === "string" &&
  typeof value["revision"] === "number" &&
  typeof value["status"] === "string" &&
  STATUSES.has(value["status"]);

const isProposal = (value: unknown): value is CreatorProposal =>
  isRecord(value) && typeof value["id"] === "string" && Array.isArray(value["items"]);

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
