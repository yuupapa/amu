import { ArrowRightLeftIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";

import { uiFormat, uiText } from "~/uiText";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { HANDOFF_NOT_CARRIED, type SwitchBannerModel } from "./providerSwitchView";

// The composer's switch banners (design §8.2). The server's state decides
// which one shows; the buttons send the user's choice back.

export interface SwitchBannerActions {
  readonly retry: (switchId: string) => void;
  readonly abort: (switchId: string, returnToPrevious: boolean) => void;
  readonly resolve: (switchId: string, decision: "resend" | "discard") => void;
}

export function switchStatusBannerItem(
  model: SwitchBannerModel | null,
  actions: SwitchBannerActions,
  busy: boolean,
): ComposerBannerStackItem | null {
  if (model === null) return null;
  switch (model.kind) {
    case "in-progress":
      return {
        id: "provider-switch:in-progress",
        variant: "info",
        priority: "activity",
        icon: <LoaderCircleIcon className="animate-spin" />,
        title: uiFormat("Handing the conversation over to {0}", model.toLabel),
      };
    case "closing":
      return {
        id: "provider-switch:closing",
        variant: "info",
        priority: "activity",
        icon: <LoaderCircleIcon className="animate-spin" />,
        title: model.returnToPrevious
          ? uiText("Cancelling the switch and returning to the previous model")
          : uiText("Cancelling the model switch"),
      };
    case "failed-retryable":
      return {
        id: `provider-switch:failed:${model.switchId}`,
        variant: "error",
        icon: <TriangleAlertIcon />,
        title: uiFormat("Could not switch to {0}", model.toLabel),
        ...(model.detail ? { description: model.detail } : {}),
        actions: (
          <>
            <Button size="xs" disabled={busy} onClick={() => actions.retry(model.switchId)}>
              {uiText("Try again")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => actions.abort(model.switchId, false)}
            >
              {uiText("Stop the switch")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => actions.abort(model.switchId, true)}
            >
              {uiFormat("Return to {0}", model.fromLabel)}
            </Button>
          </>
        ),
      };
    case "unknown-delivery":
      return {
        id: `provider-switch:unknown:${model.switchId}`,
        variant: "warning",
        icon: <TriangleAlertIcon />,
        title: uiFormat("Could not confirm that the message reached {0}", model.toLabel),
        ...(model.detail ? { description: model.detail } : {}),
        actions: (
          <>
            <Button
              size="xs"
              disabled={busy}
              onClick={() => actions.resolve(model.switchId, "resend")}
            >
              {uiText("Send again")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => actions.resolve(model.switchId, "discard")}
            >
              {uiText("Close without sending")}
            </Button>
          </>
        ),
      };
  }
}

/** "The next send hands over" (§8.2), with what does not carry over the first time (§8.5). */
export function handoffNoticeBannerItem(input: {
  readonly fromLabel: string;
  readonly toLabel: string;
  readonly explain: boolean;
  /** Null when picking the holder again would hand over too: nothing to cancel. */
  readonly onCancel: (() => void) | null;
}): ComposerBannerStackItem {
  return {
    id: `provider-switch:notice:${input.toLabel}`,
    variant: "info",
    icon: <ArrowRightLeftIcon />,
    // Back to the same model after a closed switch: its old cursor is gone.
    title:
      input.fromLabel === input.toLabel
        ? uiFormat("The next message hands the conversation to {0} again", input.toLabel)
        : uiFormat("The next message hands over from {0} to {1}", input.fromLabel, input.toLabel),
    ...(input.explain ? { description: HANDOFF_NOT_CARRIED } : {}),
    ...(input.onCancel !== null
      ? { dismissLabel: uiText("Cancel the switch"), onDismiss: input.onCancel }
      : {}),
  };
}
