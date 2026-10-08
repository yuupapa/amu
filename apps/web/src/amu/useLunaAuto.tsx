import {
  autoChoices,
  isNewAutoRequest,
  type AutoChoice,
  type AutoDecision,
} from "@t3tools/shared/lunaAuto";
import { createModelSelection } from "@t3tools/shared/model";
import type { ModelSelection, ScopedThreadRef, ServerProvider } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { ChatComposerHandle } from "../components/chat/ChatComposer";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
} from "../components/chat/composerProviderState";
import { Button } from "../components/ui/button";
import {
  autoRecoveryMessage,
  cancelPendingAutoRecord,
  AutoRecordUnreadableError,
  discardAutoRecord,
  issueLunaTicket,
  lunaAutoDecide,
  lunaAutoRequest,
  type AutoFolderAnswer,
  readAutoRecord,
  runLunaAuto,
  type AutoTicket,
} from "../lib/lunaAuto";
import { uiText } from "../uiText";

/**
 * Amu's "Auto": for the first request of a thread, a connected AI (Haiku, then
 * Luna, then Composer; see LUNA_JUDGE_ORDER) picks the model and reasoning effort, then the normal send path runs with that pick.
 * ChatView calls `startIfAuto` at the top of its send handler and reads the
 * send context through `withDecision`; everything else lives here so the
 * upstream send path stays as it is. See docs/user/luna-auto.md.
 */

type SendContext = NonNullable<ReturnType<ChatComposerHandle["getSendContext"]>>;

type ProviderEntry = {
  readonly instanceId: string;
  readonly driverKind: string;
  readonly enabled: boolean;
  readonly isAvailable: boolean;
  readonly status: string;
  readonly models: ServerProvider["models"];
  readonly snapshot: ServerProvider;
};

export type LunaAutoInputs = {
  readonly routeThreadKey: string;
  /** Auto talks to the local Amu backend only. */
  readonly onPrimaryEnvironment: boolean;
  /** The thread has a message or a running session. */
  readonly started: boolean;
  /** Connecting or the environment is unreachable. */
  readonly unavailable: boolean;
  readonly providers: ReadonlyArray<ProviderEntry>;
  readonly planModeEnabled: boolean;
  readonly currentRouteThreadKey: () => string | null;
  readonly getSendContext: () => SendContext | undefined;
  readonly runtimeMode: () => unknown;
  readonly showError: (message: string) => void;
  /** Put the request back in the composer when the send cleared it. */
  readonly restorePrompt: (prompt: string) => void;
  readonly currentPrompt: () => string;
  /** The thread this view shows now. */
  readonly currentThreadRef: () => ScopedThreadRef | null;
  /** Keep Luna's pick in that thread's composer, so its next message stays on it. */
  readonly rememberPick: (thread: ScopedThreadRef, selection: ModelSelection) => void;
  /**
   * The current folder and Amu's projects, so Auto can also pick where the
   * request belongs; null when this draft cannot move (see amu/autoFolder.ts).
   */
  readonly folderContext: () => AutoFolderContext | null;
  /** Moves the draft to the picked folder; resolves to its name, or null when it stays. */
  readonly moveToFolder: (answer: AutoFolderAnswer) => Promise<string | null>;
};

export type AutoFolderContext = {
  readonly current: string | null;
  readonly projects: ReadonlyArray<{ path: string; titles: string[]; updatedAt: string }>;
};

type Prepared = { decision: AutoDecision; choice: AutoChoice; ticket: AutoTicket };
type Status = { key: string; text: string; busy: boolean };

// Up to three judges may try in turn (45 s, 45 s and 60 s on the server).
const SEND_TIMEOUT_MS = 160_000;

function hasNonPromptContent(ctx: SendContext): boolean {
  return (
    ctx.images.length +
      ctx.files.length +
      ctx.terminalContexts.length +
      ctx.previewAnnotations.length +
      ctx.reviewComments.length +
      ctx.threadContexts.length >
    0
  );
}

function recordExists(thread: string): boolean {
  try {
    return readAutoRecord(thread) !== null;
  } catch {
    return true;
  }
}

export function useLunaAuto(inputs: LunaAutoInputs) {
  const { routeThreadKey } = inputs;
  const live = useRef(inputs);
  live.current = inputs;

  const [mode, setMode] = useState({ key: routeThreadKey, enabled: false });
  const [status, setStatus] = useState<Status | null>(null);
  const [manualRecoveryKey, setManualRecoveryKey] = useState<string | null>(null);
  /** The id is known once the server has issued it. */
  const pending = useRef<{ id: string | null; controller: AbortController } | null>(null);
  const prepared = useRef<Prepared | null>(null);
  const dispatched = useRef<ModelSelection | null>(null);

  const cancelPending = useCallback(() => {
    const current = pending.current;
    if (!current) return;
    current.controller.abort();
    if (current.id) void lunaAutoRequest({ id: current.id, action: "cancel" }).catch(() => {});
  }, []);

  // Leaving the thread stops a judgement that is still running.
  useEffect(() => () => cancelPending(), [routeThreadKey, cancelPending]);

  const setAuto = useCallback(
    (enabled: boolean) => {
      cancelPending();
      setMode({ key: live.current.routeThreadKey, enabled });
    },
    [cancelPending],
  );

  const judging = status?.key === routeThreadKey && status.busy;
  const offered =
    inputs.onPrimaryEnvironment && !inputs.started && (judging || !recordExists(routeThreadKey));
  const autoOn = offered && mode.key === routeThreadKey && mode.enabled;

  /** Returns true when this send was taken over (or refused) by Auto. */
  const startIfAuto = (
    sendCtx: SendContext | undefined,
    directAnnotation: unknown,
    resend: () => Promise<boolean | undefined>,
  ): boolean => {
    if (prepared.current) return false;
    if (pending.current) return true;
    const key = live.current.routeThreadKey;
    if (manualRecoveryKey !== key) {
      try {
        const record = readAutoRecord(key);
        if (record && ["judging", "ready", "dispatching", "uncertain"].includes(record.state)) {
          setStatus({
            key,
            busy: false,
            text: autoRecoveryMessage(key) ?? "前回の会話と実行状態を確認してください。",
          });
          return true;
        }
      } catch {
        setStatus({
          key,
          busy: false,
          text: "オートの保存状態を確認できません。会話と実行状態を確認して手動に戻してください。",
        });
        return true;
      }
    }
    if (
      !sendCtx ||
      !isNewAutoRequest({
        enabled: mode.key === key && mode.enabled && live.current.onPrimaryEnvironment,
        hasSession: live.current.started,
        hasUserMessage: live.current.started,
        contextCount: 0,
        multipleModels: false,
      })
    ) {
      return false;
    }
    if (
      hasNonPromptContent(sendCtx) ||
      directAnnotation !== undefined ||
      sendCtx.multipleModelSelections !== null ||
      sendCtx.prompt.trim().startsWith("/")
    ) {
      live.current.showError(
        "オートは新しい依頼の本文だけを判断します。添付・複数モデル・コマンドは手動でモデルを選んで送信してください。",
      );
      return true;
    }
    if (!sendCtx.prompt.trim()) return true;

    const promptSnapshot = sendCtx.prompt;
    const selectionSnapshot = JSON.stringify(sendCtx.selectedModelSelection);
    const accessSnapshot = JSON.stringify({
      runtimeMode: live.current.runtimeMode(),
      interactionMode: sendCtx.interactionMode,
    });
    const choices = autoChoices(
      live.current.providers.filter((p) => p.enabled && p.isAvailable).map((p) => p.snapshot),
    );
    const unchanged = () => {
      const current = live.current.getSendContext();
      return (
        live.current.currentRouteThreadKey() === key &&
        !live.current.started &&
        !live.current.unavailable &&
        current?.prompt === promptSnapshot &&
        JSON.stringify(current.selectedModelSelection) === selectionSnapshot &&
        JSON.stringify({
          runtimeMode: live.current.runtimeMode(),
          interactionMode: current.interactionMode,
        }) === accessSnapshot &&
        !hasNonPromptContent(current)
      );
    };
    const threadRef = live.current.currentThreadRef();
    const controller = new AbortController();
    const current: { id: string | null; controller: AbortController } = { id: null, controller };
    pending.current = current;
    setStatus({
      key,
      busy: true,
      text: "オートがモデルを選んでいます。元の依頼は保持しています。",
    });
    const timeout = window.setTimeout(() => {
      controller.abort();
      if (current.id) void lunaAutoRequest({ id: current.id, action: "cancel" }).catch(() => {});
    }, SEND_TIMEOUT_MS);

    void (async () => {
      try {
        // The server hands out the id, so it can refuse a stale or replayed
        // request even after it restarts.
        const id = await issueLunaTicket(controller.signal);
        current.id = id;
        let judge: string | null = null;
        let folderAnswer: AutoFolderAnswer | null = null;
        let folderName: string | null = null;
        const folders = live.current.folderContext();
        const decision = await runLunaAuto({
          thread: key,
          id,
          signal: controller.signal,
          choices,
          unchanged,
          decide: async () => {
            const answer = await lunaAutoDecide(
              {
                id,
                action: "decide",
                prompt: promptSnapshot,
                models: choices.map((c) => ({ instanceId: c.instanceId, model: c.model })),
                ...(folders ? { folders } : {}),
              },
              controller.signal,
            );
            judge = answer.judge;
            folderAnswer = answer.folder;
            return answer.result;
          },
          send: async (decision, choice, ticket) => {
            // Start in the folder the request belongs to. If moving fails, the
            // draft stays where it is and the send goes on there.
            if (folderAnswer && folderAnswer.kind !== "current") {
              folderName = await live.current.moveToFolder(folderAnswer).catch(() => null);
            }
            prepared.current = { decision, choice, ticket };
            dispatched.current = null;
            try {
              const accepted = (await resend()) === true;
              if (accepted && dispatched.current && threadRef) {
                live.current.rememberPick(threadRef, dispatched.current);
              }
              return accepted;
            } finally {
              prepared.current = null;
            }
          },
        });
        if (live.current.currentRouteThreadKey() === key) {
          const picked = choices.find((c) => c.model === decision.model);
          const descriptor = live.current.providers
            .find((p) => p.instanceId === picked?.instanceId)
            ?.models.find((m) => m.slug === decision.model)
            ?.capabilities?.optionDescriptors?.find((d) => d.id === picked?.effortId);
          const effortLabel =
            descriptor?.type === "select"
              ? descriptor.options.find((o) => o.id === decision.effort)?.label
              : undefined;
          setStatus({
            key,
            busy: false,
            text: `オート${judge ? `（${judge}が判定）` : ""}：${picked?.name ?? decision.model}・${
              effortLabel ? uiText(effortLabel) : decision.effort
            } — ${decision.reason.replace(/[。．.]+$/u, "")}${
              folderName ? `（フォルダー：${folderName}）` : ""
            }`,
          });
        }
      } catch (error) {
        if (live.current.currentRouteThreadKey() === key) {
          setMode({ key, enabled: false });
          if (live.current.currentPrompt() === "") live.current.restorePrompt(promptSnapshot);
          const text =
            error instanceof Error && error.name !== "AbortError"
              ? error.message
              : "モデル選択を取り消したか、時間内に完了しませんでした。元の依頼を残して手動送信に戻ります。";
          live.current.showError(text);
          setStatus({ key, busy: false, text });
        }
      } finally {
        window.clearTimeout(timeout);
        if (pending.current === current) pending.current = null;
      }
    })();
    return true;
  };

  /** The send context with Luna's pick, while Auto's own send is running. */
  const withDecision = (sendCtx: SendContext | undefined): SendContext | undefined => {
    const current = prepared.current;
    if (!current || !sendCtx) return sendCtx;
    const { choice, decision, ticket } = current;
    const provider = live.current.providers.find(
      (p) =>
        p.instanceId === choice.instanceId && p.enabled && p.isAvailable && p.status === "ready",
    );
    const stillOffered = autoChoices(
      live.current.providers.filter((p) => p.enabled && p.isAvailable).map((p) => p.snapshot),
    ).some(
      (c) =>
        c.instanceId === choice.instanceId &&
        c.model === decision.model &&
        c.efforts.includes(decision.effort),
    );
    // Not sending leaves the record "ready"; runLunaAuto then reports it.
    if (ticket.signal.aborted || !provider || !stillOffered || !ticket.markDispatch()) {
      return undefined;
    }
    // From here the send is under way; the judgement can no longer be cancelled.
    setStatus({
      key: live.current.routeThreadKey,
      busy: false,
      text: "オートが選んだモデルで送信しています。",
    });
    const selection = createModelSelection(
      provider.instanceId as never,
      decision.model,
      choice.effortId ? [{ id: choice.effortId, value: decision.effort }] : [],
    );
    const state = getComposerProviderState({
      provider: provider.driverKind as never,
      model: decision.model,
      models: provider.models,
      modelOptions: selection.options,
      promptInjectionState: getComposerPromptInjectionState(sendCtx.prompt),
      planModeEnabled: live.current.planModeEnabled,
    });
    const selectedModelSelection = createModelSelection(
      provider.instanceId as never,
      decision.model,
      state.modelOptionsForDispatch,
    );
    dispatched.current = selectedModelSelection;
    return {
      ...sendCtx,
      selectedProvider: provider.driverKind as never,
      selectedModel: decision.model,
      selectedProviderModels: provider.models,
      selectedModelSelection,
      selectedPromptEffort: state.promptEffort,
      selectedModelOptionsForDispatch: state.modelOptionsForDispatch,
      providerAvailable: true,
    };
  };

  const recoveryText = autoRecoveryMessage(routeThreadKey);
  const statusText =
    status?.key === routeThreadKey
      ? status.text
      : (recoveryText ??
        (autoOn ? "オート：送信すると、つながっているAIがモデルと思考の強さを選びます。" : null));

  const statusElement: ReactNode = statusText ? (
    <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 px-1 text-xs text-muted-foreground">
      <span role="status" aria-label="モデル自動選択の状態">
        {statusText}
      </span>
      {judging ? (
        <Button variant="outline" size="sm" onClick={() => setAuto(false)}>
          判定を取り消す
        </Button>
      ) : null}
      {recoveryText && manualRecoveryKey !== routeThreadKey && !pending.current ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void cancelPendingAutoRecord(routeThreadKey)
              // A record that cannot be read is set aside, so the thread can send again.
              .catch((error: unknown) => {
                if (error instanceof AutoRecordUnreadableError) {
                  discardAutoRecord(routeThreadKey);
                  return;
                }
                throw error;
              })
              .then(() => {
                setManualRecoveryKey(routeThreadKey);
                setMode({ key: routeThreadKey, enabled: false });
                setStatus({
                  key: routeThreadKey,
                  busy: false,
                  text: "手動送信に戻りました。元の依頼と選択モデルを確認して送信してください。",
                });
              })
              .catch((error: unknown) =>
                setStatus({
                  key: routeThreadKey,
                  busy: false,
                  text:
                    error instanceof Error ? error.message : "手動送信への復帰を確認できません。",
                }),
              );
          }}
        >
          実行状態を確認して手動に戻る
        </Button>
      ) : null}
    </div>
  ) : null;

  return {
    offered,
    autoOn,
    judging,
    setAuto,
    startIfAuto,
    withDecision,
    statusElement,
  };
}
