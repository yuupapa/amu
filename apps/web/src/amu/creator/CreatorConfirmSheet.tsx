/**
 * The Amu Creator confirm sheet: the user sees exactly what the server pinned
 * for the proposal (full text, time, place, image) and approves it here, in the
 * Amu window, never in the guest page. Approval goes to the desktop main first
 * (`creatorApprove`, decided against navigation there), then the server sends.
 * This component never touches the chat composer.
 */
import type {
  CreatorBindingId,
  CreatorPlace,
  CreatorProposal,
  CreatorProposalItem,
  CreatorSendResult,
  CreatorSnapshot,
  EnvironmentId,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { creatorEnvironment } from "~/state/creator";
import { useAtomCommand } from "~/state/use-atom-command";

import type { CreatorBridgeView } from "./creatorBridge";
import { creatorSendReasonText, creatorSheetPhase, formatCreatorTime } from "./creatorSheet";
import { CREATOR_PAGE_CHANGED, creatorErrorMessage } from "./creatorText";
import { toCreatorCallResult } from "./useCreatorSession";

function placeText(place: CreatorPlace | null): string {
  if (place === null) return "場所なし";
  const parts = [
    place.compositionFile,
    place.elementSelector,
    place.elementLabel ? `（${place.elementLabel}）` : null,
    `x ${place.x.toFixed(2)}, y ${place.y.toFixed(2)}`,
  ];
  return parts.filter((part) => part !== null && part !== "").join(" ");
}

function ShotImage(props: {
  readonly environmentId: EnvironmentId;
  readonly bindingId: CreatorBindingId;
  readonly epoch: number | null;
  readonly item: CreatorProposalItem;
}) {
  const readShot = useAtomCommand(creatorEnvironment.readShot, { reportFailure: false });
  const shot = props.item.shot;
  const [url, setUrl] = useState<string | null | "missing">(null);
  useEffect(() => {
    if (shot === null || props.epoch === null) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    void readShot({
      environmentId: props.environmentId,
      input: {
        bindingId: props.bindingId,
        epoch: props.epoch,
        commentId: shot.commentId,
        revision: shot.revision,
      },
    }).then((result) => {
      if (cancelled) return;
      const read = toCreatorCallResult(result);
      if (!read.ok) {
        setUrl("missing");
        return;
      }
      objectUrl = URL.createObjectURL(
        new Blob([new Uint8Array(read.value.png)], { type: "image/png" }),
      );
      setUrl(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [props.bindingId, props.environmentId, props.epoch, readShot, shot]);

  if (shot === null || url === "missing") {
    return <p className="text-xs text-muted-foreground">画像なし</p>;
  }
  if (url === null) return <p className="text-xs text-muted-foreground">画像を読み込み中…</p>;
  return (
    <img
      src={url}
      alt={`コメント #${props.item.number} の画像`}
      width={shot.width}
      height={shot.height}
      className="h-auto max-h-60 w-auto max-w-full rounded-md border"
    />
  );
}

export function CreatorConfirmSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly runtimeTabId: string;
  readonly bindingId: CreatorBindingId;
  readonly view: CreatorBridgeView;
  readonly snapshot: CreatorSnapshot | null;
  /** The proposal as `propose` returned it. */
  readonly proposal: CreatorProposal;
  readonly threadTitle: string | null;
  readonly onClose: () => void;
}) {
  const { environmentId, bindingId, view, snapshot, onClose } = props;
  const quiet = { reportFailure: false } as const;
  const confirmSend = useAtomCommand(creatorEnvironment.confirmSend, quiet);
  const haltSend = useAtomCommand(creatorEnvironment.haltSend, quiet);
  const acknowledgeConflict = useAtomCommand(creatorEnvironment.acknowledgeConflict, quiet);
  const cancelProposal = useAtomCommand(creatorEnvironment.cancelProposal, quiet);

  const pinned = props.proposal;
  const live = snapshot?.proposals.find((proposal) => proposal.id === pinned.id) ?? null;
  const [seenLive, setSeenLive] = useState(false);
  if (!seenLive && live !== null) setSeenLive(true);
  const [submitted, setSubmitted] = useState(false);
  const [result, setResult] = useState<CreatorSendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const phase = creatorSheetPhase({ snapshot, pinned, submitted, result, seenLive });
  const gone = phase.kind === "gone";
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);

  const binding = view.epoch === null ? null : { bindingId, epoch: view.epoch };

  const send = async () => {
    if (view.generation === null || binding === null || !previewBridge) {
      setError(CREATOR_PAGE_CHANGED);
      return;
    }
    setBusy(true);
    setError(null);
    const approval = await previewBridge
      .creatorApprove({
        tabId: props.runtimeTabId,
        generation: view.generation,
        proposalId: pinned.id,
      })
      .catch((): { ok: false; reason: string } => ({ ok: false, reason: "ipc" }));
    if (!approval.ok) {
      setBusy(false);
      setError(CREATOR_PAGE_CHANGED);
      return;
    }
    setSubmitted(true);
    const answer = toCreatorCallResult(
      await confirmSend({
        environmentId,
        input: {
          bindingId,
          epoch: approval.epoch,
          proposalId: pinned.id,
          revisionKey: pinned.revisionKey,
        },
      }),
    );
    setBusy(false);
    if (answer.ok) {
      setResult(answer.value);
      return;
    }
    setSubmitted(false);
    setError(creatorErrorMessage(answer.error));
  };

  const runOnProposal = async (
    run: typeof haltSend | typeof acknowledgeConflict,
    after?: (value: CreatorSendResult) => void,
  ) => {
    if (binding === null) return;
    setBusy(true);
    setError(null);
    const answer = toCreatorCallResult(
      await run({ environmentId, input: { ...binding, proposalId: pinned.id } }),
    );
    setBusy(false);
    if (answer.ok) after?.(answer.value);
    else setError(creatorErrorMessage(answer.error));
  };

  const cancel = async () => {
    if (binding === null) {
      onClose();
      return;
    }
    setBusy(true);
    const answer = toCreatorCallResult(
      await cancelProposal({ environmentId, input: { ...binding, proposalId: pinned.id } }),
    );
    setBusy(false);
    if (answer.ok) onClose();
    else setError(creatorErrorMessage(answer.error));
  };

  const items = pinned.items;
  const status = (() => {
    switch (phase.kind) {
      case "loading":
        return "読み込み中…";
      case "sending":
        return phase.checking ? "送信を確認中…" : "送信中…";
      case "stuck":
        return "送信を確認できません。「送信をやめる」で止められます";
      case "halted":
        return phase.unverified
          ? "送ったかどうか確かめられません。スレッドを確認してください"
          : "送信を止めています…";
      case "conflict":
        return "送信の記録が一致しません。スレッドを確認してください";
      case "sent":
        return "送信しました";
      case "failed":
        return ["送信できませんでした", creatorSendReasonText(phase.reason)]
          .filter((part) => part !== "")
          .join("。");
      default:
        return null;
    }
  })();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (open || busy) return;
        // Dismissing before sending withdraws the proposal, so it never waits
        // for a sheet that is gone; after that, closing only hides the sheet.
        if (phase.kind === "review") void cancel();
        else onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Amu Creator から送信</DialogTitle>
          <DialogDescription>
            宛先：{props.threadTitle ?? "このスレッド"}　{items.length} 件
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <ol className="space-y-4">
            {items.map((item) => (
              <li key={item.commentId} className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>#{item.number}</span>
                  <span>{formatCreatorTime(item.timeSec)}</span>
                  <span>{placeText(item.place)}</span>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm">{item.comment}</p>
                <ShotImage
                  environmentId={environmentId}
                  bindingId={bindingId}
                  epoch={view.epoch}
                  item={item}
                />
              </li>
            ))}
          </ol>
          {status !== null ? (
            <p role="status" className="text-sm">
              {status}
            </p>
          ) : null}
          {error !== null ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {phase.kind === "review" ? (
            <>
              <Button variant="outline" disabled={busy} onClick={() => void cancel()}>
                取り消し
              </Button>
              <Button disabled={busy} onClick={() => void send()}>
                送信
              </Button>
            </>
          ) : phase.kind === "sending" || phase.kind === "stuck" ? (
            <Button
              variant="outline"
              disabled={busy || !live?.send}
              onClick={() => void runOnProposal(haltSend, setResult)}
            >
              送信をやめる
            </Button>
          ) : phase.kind === "conflict" ? (
            <>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                閉じる
              </Button>
              <Button disabled={busy} onClick={() => void runOnProposal(acknowledgeConflict)}>
                確認した
              </Button>
            </>
          ) : (
            <Button variant="outline" disabled={busy} onClick={onClose}>
              閉じる
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
