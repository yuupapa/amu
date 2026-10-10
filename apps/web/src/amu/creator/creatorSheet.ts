/**
 * What the Amu Creator confirm sheet shows, decided from the server snapshot.
 * The sheet never trusts its own request for the outcome: "送信中…" stays until
 * the snapshot shows the send settled (sent, back to draft, conflict, stuck or halted).
 */
import type { CreatorProposal, CreatorSendResult, CreatorSnapshot } from "@t3tools/contracts";

export type CreatorSheetPhase =
  | { readonly kind: "loading" }
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
  readonly pinned: CreatorProposal | null;
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
  if (pinned === null) return { kind: "loading" };
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
  // Not listed yet: the sheet shows what `propose` returned until a snapshot catches up.
  if (!seenLive) return submitted ? { kind: "sending", checking: false } : { kind: "review" };
  if (result?.state === "rejected") return { kind: "failed", reason: result.reason };
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

/** `76.25` -> `1:16.3`, as the guest panel and the sent message show times. */
export function formatCreatorTime(timeSec: number): string {
  const tenths = Math.round(timeSec * 10);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}
