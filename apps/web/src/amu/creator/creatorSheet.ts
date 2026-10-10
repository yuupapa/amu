/**
 * What the Amu Creator confirm sheet shows, decided from the server snapshot.
 * The sheet never trusts its own request for the outcome: "送信中…" stays until
 * the snapshot shows the send settled (sent, back to draft, conflict, stuck or halted).
 */
import type {
  CreatorBindingId,
  CreatorProposal,
  CreatorProposalId,
  CreatorSendResult,
  CreatorSnapshot,
  DesktopPreviewCreatorApproveInput,
  DesktopPreviewCreatorApproveResult,
} from "@t3tools/contracts";

import type { CreatorCallResult } from "./creatorBridge";
import { CREATOR_PAGE_CHANGED, creatorErrorMessage } from "./creatorText";

export type CreatorSheetPhase =
  | { readonly kind: "review" }
  | { readonly kind: "sending"; readonly checking: boolean }
  | { readonly kind: "stuck" }
  | { readonly kind: "halted"; readonly unverified: boolean }
  | { readonly kind: "conflict" }
  | { readonly kind: "sent" }
  | { readonly kind: "failed"; readonly reason: string | null }
  /** The proposal went away without a send from this sheet (cancelled or voided). */
  | { readonly kind: "gone" };

export function creatorSheetPhase(input: {
  readonly snapshot: CreatorSnapshot | null;
  /** The proposal as the sheet first saw it (kept after it finishes). */
  readonly pinned: CreatorProposal;
  /** The user pressed 「送信」 and the request has not been refused. */
  readonly submitted: boolean;
  /** What `confirmSend` (or `haltSend`) answered, if it answered. */
  readonly result: CreatorSendResult | null;
  /**
   * A snapshot has listed the proposal. The sheet opens from the `propose`
   * answer, which can arrive before the snapshot that contains it.
   */
  readonly seenLive: boolean;
}): CreatorSheetPhase {
  const { snapshot, pinned, submitted, result, seenLive } = input;
  const live = snapshot?.proposals.find((proposal) => proposal.id === pinned.id);
  if (live) {
    const send = live.send;
    if (send === null) return submitted ? { kind: "sending", checking: false } : { kind: "review" };
    switch (send.state) {
      case "sending":
        return { kind: "sending", checking: send.attempts > 0 };
      case "stuck":
        return { kind: "stuck" };
      case "halted":
        return { kind: "halted", unverified: (send.reason ?? "").startsWith("unverified") };
      case "conflict":
        return { kind: "conflict" };
      case "accepted":
        return { kind: "sent" };
      case "rejected":
        return { kind: "failed", reason: send.reason };
    }
  }
  const messageId = `creator:${pinned.id}`;
  const comments = new Map((snapshot?.comments ?? []).map((comment) => [comment.id, comment]));
  const landed =
    snapshot !== null &&
    pinned.items.every((item) => comments.get(item.commentId)?.sentMessageId === messageId);
  if (landed) return { kind: "sent" };
  if (result?.state === "rejected") return { kind: "failed", reason: result.reason };
  // No snapshot yet, or one that does not list the proposal yet: show what
  // `propose` returned until the server state catches up.
  if (snapshot === null || !seenLive) {
    return submitted ? { kind: "sending", checking: false } : { kind: "review" };
  }
  return submitted ? { kind: "failed", reason: result?.reason ?? null } : { kind: "gone" };
}

/** Japanese for a rejected send's stored reason. */
export function creatorSendReasonText(reason: string | null): string {
  if (reason === null) return "";
  if (reason === "halted") return "送信をやめました";
  if (reason === "thread_archived") return "宛先のスレッドがアーカイブされています";
  if (reason === "thread_not_found") return "宛先のスレッドが見つかりません";
  if (reason.startsWith("unverified")) return "送ったかどうか確かめられません";
  if (reason === "AttachmentClaimError")
    return "画像を添付できませんでした（容量が大きすぎる可能性があります）";
  return `理由: ${reason}`;
}

/**
 * The item's image still shows the comment's previous place (re-placed, and
 * the new place's capture never arrived). The proposal is voided by any change
 * to its comments, so the live comment's mark is the pinned item's.
 */
export function creatorShotIsStale(
  snapshot: CreatorSnapshot | null,
  item: CreatorProposal["items"][number],
): boolean {
  if (item.shot === null) return false;
  return snapshot?.comments.find((comment) => comment.id === item.commentId)?.shotStale === true;
}

/** `76.25` -> `1:16.3`, as the guest panel and the sent message show times. */
export function formatCreatorTime(timeSec: number): string {
  const tenths = Math.round(timeSec * 10);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/** Send states the user may have to act on (stop, or acknowledge a conflict). */
const NEEDS_USER = new Set(["sending", "stuck", "halted", "conflict"]);

/**
 * A started send the user should be able to get back to after its sheet closed
 * (revocation, 閉じる, a restart): the first one, unless its sheet is open.
 */
export function creatorAttentionProposal(
  snapshot: CreatorSnapshot | null,
  openProposalId: CreatorProposalId | null,
): CreatorProposal | null {
  return (
    snapshot?.proposals.find(
      (proposal) =>
        proposal.send !== null &&
        NEEDS_USER.has(proposal.send.state) &&
        proposal.id !== openProposalId,
    ) ?? null
  );
}

export type ApproveAndSendOutcome =
  | { readonly ok: true; readonly result: CreatorSendResult }
  | { readonly ok: false; readonly approved: boolean; readonly message: string };

/**
 * 「送信」: main approves first (decided there against navigation), and the
 * server send carries the epoch main returned with that approval.
 */
export async function approveAndSend(input: {
  readonly tabId: string;
  readonly generation: number;
  readonly bindingId: CreatorBindingId;
  readonly proposal: CreatorProposal;
  readonly approve: (
    input: DesktopPreviewCreatorApproveInput,
  ) => Promise<DesktopPreviewCreatorApproveResult>;
  readonly confirmSend: (input: {
    readonly bindingId: CreatorBindingId;
    readonly epoch: number;
    readonly proposalId: CreatorProposalId;
    readonly revisionKey: string;
  }) => Promise<CreatorCallResult<CreatorSendResult>>;
}): Promise<ApproveAndSendOutcome> {
  const approval = await input
    .approve({ tabId: input.tabId, generation: input.generation, proposalId: input.proposal.id })
    .catch((): DesktopPreviewCreatorApproveResult => ({ ok: false, reason: "ipc" }));
  if (!approval.ok) return { ok: false, approved: false, message: CREATOR_PAGE_CHANGED };
  const answer = await input.confirmSend({
    bindingId: input.bindingId,
    epoch: approval.epoch,
    proposalId: input.proposal.id,
    revisionKey: input.proposal.revisionKey,
  });
  return answer.ok
    ? { ok: true, result: answer.value }
    : { ok: false, approved: true, message: creatorErrorMessage(answer.error) };
}
