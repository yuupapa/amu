import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { Button } from "../components/ui/button";

/**
 * 結パパ's rule (2026-10-07): switching models mid-chat is always allowed, and
 * the only confirmation is a notice above the composer before the next send,
 * with a way to go back. Upstream hands the conversation over on that send;
 * this only says so and offers to undo the pick.
 */

type ProviderEntry = {
  readonly instanceId: string;
  readonly models: ServerProvider["models"];
};

export type SwitchNoticeInputs = {
  /** The thread has messages, so the next send continues it. */
  readonly started: boolean;
  /** The model the thread runs on now. */
  readonly current: ModelSelection | null;
  /** The model picked in the composer, when one was picked explicitly. */
  readonly picked: ModelSelection | null;
  readonly providers: ReadonlyArray<ProviderEntry>;
  /** Put the composer back on the thread's model. */
  readonly undo: (selection: ModelSelection) => void;
};

function modelName(providers: ReadonlyArray<ProviderEntry>, selection: ModelSelection): string {
  const entry = providers.find((provider) => provider.instanceId === selection.instanceId);
  return entry?.models.find((model) => model.slug === selection.model)?.name ?? selection.model;
}

export function switchNoticeText(inputs: SwitchNoticeInputs): string | null {
  const { started, current, picked } = inputs;
  if (!started || current === null || picked === null) return null;
  // Same provider: the conversation simply continues on the other model.
  if (picked.instanceId === current.instanceId) return null;
  return `次の送信で ${modelName(inputs.providers, current)} → ${modelName(
    inputs.providers,
    picked,
  )} に引き継ぎます`;
}

export function useSwitchNotice(inputs: SwitchNoticeInputs): ReactNode {
  const text = switchNoticeText(inputs);
  if (text === null || inputs.current === null) return null;
  const current = inputs.current;
  return (
    <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 px-1 text-xs text-muted-foreground">
      <span role="status">{text}</span>
      <Button variant="outline" size="sm" onClick={() => inputs.undo(current)}>
        乗り換えを取り消す
      </Button>
    </div>
  );
}
