import type { OrchestrationGetHandoffPacketResult } from "@t3tools/contracts";

import { uiFormat, uiText } from "~/uiText";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** The packet the new model read when the conversation was handed over (§8.3). */
export type HandoffPacketDialogState =
  | { readonly status: "closed" }
  | { readonly status: "loading"; readonly label: string }
  | { readonly status: "error"; readonly label: string; readonly message: string }
  | {
      readonly status: "loaded";
      readonly label: string;
      readonly packet: OrchestrationGetHandoffPacketResult;
    };

export function HandoffPacketDialog({
  state,
  onClose,
}: {
  state: HandoffPacketDialogState;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={state.status !== "closed"}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {state.status === "closed"
              ? uiText("Handoff")
              : uiFormat("What {0} received", state.label)}
          </DialogTitle>
          {state.status === "loaded" ? (
            <DialogDescription>
              {uiFormat(
                "{0} characters · {1} messages included · {2} left out",
                state.packet.chars.toLocaleString("ja-JP"),
                state.packet.includedMessages,
                state.packet.omittedMessages,
              )}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        <DialogPanel>
          {state.status === "loading" ? (
            <p className="text-muted-foreground text-sm">{uiText("Loading")}</p>
          ) : state.status === "error" ? (
            <p className="text-destructive text-sm">{state.message}</p>
          ) : state.status === "loaded" ? (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 p-3 font-mono text-xs leading-relaxed">
              {state.packet.text}
            </pre>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
