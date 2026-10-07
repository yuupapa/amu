import { validateAutoDecision, type AutoChoice, type AutoDecision } from "@t3tools/shared/lunaAuto";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";

export type AutoState =
  | "judging"
  | "ready"
  | "dispatching"
  | "sent"
  | "blocked"
  | "cancelled"
  | "uncertain";
type AutoRecord = { id: string; state: AutoState };
export type AutoTicket = { id: string; signal: AbortSignal; markDispatch: () => boolean };
const key = (thread: string) => `amu:luna:auto-run:${thread}`;
export function readAutoRecord(thread: string): AutoRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(localStorage.getItem(key(thread)) ?? "null");
  } catch {
    throw new AutoRecordUnreadableError();
  }
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    !("id" in value) ||
    !("state" in value) ||
    typeof value.id !== "string" ||
    !["judging", "ready", "dispatching", "sent", "blocked", "cancelled", "uncertain"].includes(
      String(value.state),
    )
  )
    throw new AutoRecordUnreadableError();
  return value as AutoRecord;
}

export class AutoRecordUnreadableError extends Error {
  constructor() {
    super("オートの保存状態を確認できません。手動送信に戻してください。");
    this.name = "AutoRecordUnreadableError";
  }
}

/** Move an unreadable record aside (kept for inspection) so the thread can send again. */
export function discardAutoRecord(thread: string): void {
  const value = localStorage.getItem(key(thread));
  if (value !== null) localStorage.setItem(`amu:luna:auto-run-unreadable:${thread}`, value);
  localStorage.removeItem(key(thread));
}
function writeRecord(thread: string, value: AutoRecord) {
  localStorage.setItem(key(thread), JSON.stringify(value));
}

export function autoRecoveryMessage(thread: string): string | null {
  try {
    const record = readAutoRecord(thread);
    if (!record || record.state === "sent") return null;
    return ["dispatching", "uncertain"].includes(record.state)
      ? "前回の実行受付が不明です。会話と実行状態を確認してください。自動再送はしません。"
      : "前回のモデル選択は再開しません。元の依頼を確認し、手動でモデルを選んで送信してください。オートを使う場合は新しい会話で送信してください。";
  } catch {
    return "オートの保存状態を確認できません。元の依頼と会話を確認してください。";
  }
}

export async function cancelPendingAutoRecord(thread: string): Promise<void> {
  const record = readAutoRecord(thread);
  if (!record || !["judging", "ready"].includes(record.state)) return;
  await lunaAutoRequest({ id: record.id, action: "cancel" });
  const current = readAutoRecord(thread);
  if (current?.id === record.id && ["judging", "ready"].includes(current.state))
    writeRecord(thread, { id: record.id, state: "cancelled" });
  else if (current?.state === "dispatching" || current?.state === "uncertain")
    throw new Error("実行受付が不明です。会話と実行状態をもう一度確認してください。");
}

export async function lunaAutoRequest(body: unknown, signal?: AbortSignal): Promise<unknown> {
  const url = resolvePrimaryEnvironmentHttpUrl("/api/luna-auto");
  const target = new URL(url);
  if (
    !["http:", "https:"].includes(target.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  )
    throw new Error("オートはこのMacのローカルのAmuで利用してください。");
  const bearer = await readDesktopPrimaryBearerToken();
  const response = await fetch(url, {
    method: "POST",
    ...(signal ? { signal } : {}),
    credentials: bearer ? "omit" : "include",
    headers: {
      "Content-Type": "application/json",
      "X-Amu-Auto": "1",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as {
    result?: unknown;
    error?: string;
    cancelled?: boolean;
  };
  if (!response.ok || result.error)
    throw new Error(result.error ?? "Lunaの結果が不明です。自動再送はしません。");
  return result.result;
}

/** A single-use id from the server, needed for each judgement. */
export async function issueLunaTicket(signal?: AbortSignal): Promise<string> {
  const id = await lunaAutoRequest({ action: "issue" }, signal);
  if (typeof id !== "string" || !/^[a-zA-Z0-9-]{20,80}$/.test(id))
    throw new Error("Lunaの受付番号を受け取れませんでした。元の依頼を残して手動送信に戻ります。");
  return id;
}

/** Hold the thread lock through normal-send acknowledgment. Persist before either paid boundary. */
export async function runLunaAuto(input: {
  thread: string;
  id: string;
  signal: AbortSignal;
  choices: AutoChoice[];
  decide: () => Promise<unknown>;
  unchanged: () => boolean;
  send: (
    decision: AutoDecision,
    choice: AutoChoice,
    ticket: AutoTicket,
  ) => Promise<boolean | undefined>;
}): Promise<AutoDecision> {
  if (!navigator.locks)
    throw new Error("二重送信を防ぐロックが利用できません。手動送信に戻してください。");
  return navigator.locks.request(
    `amu-luna:${input.thread}`,
    { ifAvailable: true },
    async (lock) => {
      if (!lock || readAutoRecord(input.thread))
        throw new Error(
          "この依頼はモデル選択または送信を開始済みです。自動再送はしません。会話を確認してから手動送信に戻してください。オートを使う場合は新しい会話で送信してください。",
        );
      if (input.signal.aborted) throw new Error("モデル選択を取り消しました。");
      writeRecord(input.thread, { id: input.id, state: "judging" });
      let dispatched = false;
      try {
        const decision = validateAutoDecision(await input.decide(), input.choices);
        if (input.signal.aborted)
          throw new Error("モデル選択を取り消しました。元の依頼は保持しています。");
        if (!input.unchanged())
          throw new Error(
            "判定中に依頼・モデル・会話の状態が変わりました。現在の入力を保持して手動送信に戻ります。",
          );
        const choice = input.choices.find((c) => c.model === decision.model)!;
        writeRecord(input.thread, { id: input.id, state: "ready" });
        const accepted = await input.send(decision, choice, {
          id: input.id,
          signal: input.signal,
          markDispatch: () => {
            const record = readAutoRecord(input.thread);
            if (
              input.signal.aborted ||
              !input.unchanged() ||
              record?.id !== input.id ||
              record.state !== "ready"
            )
              return false;
            writeRecord(input.thread, { id: input.id, state: "dispatching" });
            dispatched = true;
            return true;
          },
        });
        if (accepted !== true)
          throw new Error(
            dispatched
              ? "実行の受付を確認できません。自動再送はしません。会話と実行状態を確認してください。"
              : "通常送信を開始できませんでした。元の依頼を残して手動送信に戻ります。",
          );
        writeRecord(input.thread, { id: input.id, state: "sent" });
        return decision;
      } catch (error) {
        writeRecord(input.thread, {
          id: input.id,
          state: dispatched ? "uncertain" : input.signal.aborted ? "cancelled" : "blocked",
        });
        throw error;
      }
    },
  );
}
