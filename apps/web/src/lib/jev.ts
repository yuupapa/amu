import type { JevJob, JevPlan } from "@t3tools/contracts";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";

// Jev is disconnected while the replacement for model selection is undecided.
// Keep its saved jobs and source for restoration; no stored choice can reactivate it.
export const JEV_INTEGRATION_ENABLED = false;

export async function jevRequest<T>(
  thread: string,
  method: string,
  args: unknown = {},
): Promise<T> {
  if (!JEV_INTEGRATION_ENABLED)
    throw new Error("Jev連携は停止中です。モデルを手動で選んで送信してください。");
  const url = resolvePrimaryEnvironmentHttpUrl("/api/jev");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error("JevはこのMacのローカルのAmuで利用してください。");
  }
  const bearer = await readDesktopPrimaryBearerToken();
  const response = await fetch(url, {
    method: "POST",
    credentials: bearer ? "omit" : "include",
    headers: {
      "Content-Type": "application/json",
      "X-T3-Jev": "1",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({ thread, method, args }),
  });
  const body = (await response.json()) as { result?: T; error?: string };
  if (!response.ok || body.error || !("result" in body))
    throw new Error(body.error ?? "Jevの結果が不明です。再送せず状態を確認してください。");
  return body.result as T;
}

export function readJevAuto(key: string, draft = false): boolean {
  if (!JEV_INTEGRATION_ENABLED) return false;
  try {
    const value = localStorage.getItem(`t3:jev:auto:${key}`);
    return value === null ? draft : value === "true";
  } catch {
    return draft;
  }
}
export function saveJevAuto(key: string, value: boolean) {
  if (!JEV_INTEGRATION_ENABLED) return;
  try {
    localStorage.setItem(`t3:jev:auto:${key}`, String(value));
  } catch {
    /* selection remains usable in this tab */
  }
}

/** An Auto job whose user prompt still has to start as a real turn once Jev has chosen. */
export type JevHandoff = {
  jobId: string;
  jevThread: string;
  threadId: string;
  task: string;
  selectionSnapshot?: string;
  state?: "pending" | "dispatching" | "sent" | "blocked" | "uncertain" | "cancelled";
};
const HANDOFF_KEY = "t3:jev:handoffs";
// Jev's model choice is final here; the turn can start with it.
export const JEV_HANDOFF_STATUSES = new Set(["routed", "completed"]);
// Jev stopped without a usable choice; nothing is sent automatically.
export const JEV_STOPPED_STATUSES = new Set([
  "blocked",
  "uncertain",
  "cancelled",
  "awaiting_manual_route",
  "awaiting_validation",
  "awaiting_handoff",
  "paused",
]);

export function readJevHandoffs(): JevHandoff[] {
  try {
    const value = JSON.parse(localStorage.getItem(HANDOFF_KEY) ?? "[]") as unknown;
    return Array.isArray(value)
      ? value
          .filter(
            (entry): entry is JevHandoff =>
              entry !== null &&
              typeof entry === "object" &&
              [entry.jobId, entry.jevThread, entry.threadId, entry.task].every(
                (x) => typeof x === "string",
              ) &&
              (entry.state === undefined ||
                ["pending", "dispatching", "sent", "blocked", "uncertain", "cancelled"].includes(
                  entry.state,
                )),
          )
          .map((entry) => ({ ...entry, state: entry.state ?? "blocked" }))
      : [];
  } catch {
    return [];
  }
}
function writeJevHandoffs(entries: JevHandoff[]) {
  // Losing this record could replay a paid turn after reload. Stop if persistence fails.
  localStorage.setItem(HANDOFF_KEY, JSON.stringify(entries));
}
export function saveJevHandoff(entry: JevHandoff) {
  const entries = readJevHandoffs();
  if (entries.some((x) => x.jobId === entry.jobId)) return;
  writeJevHandoffs([...entries, { ...entry, state: entry.state ?? "pending" }]);
}
export function setJevHandoffState(jobId: string, state: NonNullable<JevHandoff["state"]>) {
  writeJevHandoffs(
    readJevHandoffs().map((entry) => (entry.jobId === jobId ? { ...entry, state } : entry)),
  );
}

export function isJevHandoffDispatching(jobId: string) {
  return readJevHandoffs().some((entry) => entry.jobId === jobId && entry.state === "dispatching");
}

export function unchangedJevDraft(task: string, currentPrompt: string, contextCount: number) {
  return task === currentPrompt.trim() && contextCount === 0;
}

export function nativeJevPlan(job: JevJob): JevPlan | null {
  if (!JEV_INTEGRATION_ENABLED) return null;
  // Only a validated decision-only result can start a native turn. Full workflows and old demo
  // completions already did work (or simulated it); neither is a live routing receipt.
  const { request, plan, artifacts, plan_hash: planHash } = job.data;
  const receipt = artifacts.decision;
  if (
    job.status !== "routed" ||
    request.decision_only !== true ||
    request.text_only !== true ||
    !plan ||
    !receipt ||
    typeof receipt !== "object" ||
    !("native_handoff" in receipt) ||
    receipt.native_handoff !== true ||
    !("model_calls" in receipt) ||
    receipt.model_calls !== 0 ||
    !("mode" in receipt) ||
    receipt.mode !== request.mode ||
    !("plan_hash" in receipt) ||
    !planHash ||
    receipt.plan_hash !== planHash ||
    plan.model !== plan.worker.model ||
    plan.effort !== plan.worker.effort
  )
    return null;
  return plan;
}

export async function dispatchJevHandoff(
  entry: JevHandoff,
  readJob: () => Promise<JevJob>,
  send: (plan: JevPlan) => Promise<boolean | undefined>,
) {
  if (!JEV_INTEGRATION_ENABLED) return;
  if (!navigator.locks)
    throw new Error("二重送信を防ぐためのロックが利用できません。自動送信を停止しました。");
  return navigator.locks.request(`amu-jev-send:${entry.jobId}`, async () => {
    const current = readJevHandoffs().find((x) => x.jobId === entry.jobId);
    if (!current || (current.state !== undefined && current.state !== "pending")) return;
    // Persist before any RPC. A crash or an unknown response is never replayed automatically.
    setJevHandoffState(entry.jobId, "dispatching");
    try {
      const job = await readJob();
      const plan = job.data.request.task === entry.task ? nativeJevPlan(job) : null;
      if (!isJevHandoffDispatching(entry.jobId)) return;
      if (!plan) {
        setJevHandoffState(entry.jobId, "blocked");
        return;
      }
      const accepted = await send(plan);
      if (isJevHandoffDispatching(entry.jobId))
        setJevHandoffState(entry.jobId, accepted === true ? "sent" : "uncertain");
      if (accepted !== true)
        throw new Error(
          "実行の受付を確認できません。自動再送はしません。会話と実行状態を確認してください。",
        );
    } catch (error) {
      if (isJevHandoffDispatching(entry.jobId)) setJevHandoffState(entry.jobId, "uncertain");
      throw error;
    }
  });
}
