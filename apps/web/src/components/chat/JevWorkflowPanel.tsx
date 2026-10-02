import { useEffect, useRef, useState } from "react";
import type { JevBootstrap, JevDetail, JevJob, JevRequest } from "@t3tools/contracts";
import { jevRequest, setJevHandoffState } from "../../lib/jev";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export type JevSubmission = {
  task: string;
  source: string;
  nonce: string;
  modelSelection?: { model: string; effort: string };
  selectionSnapshot?: string;
};
const phaseLabels: Record<string, string> = {
  route: "モデル判断",
  plan: "計画",
  implement: "実装",
  checks: "検査",
  review: "レビュー",
  fix: "修正",
  final: "引継ぎ",
  complete: "完了",
  consent: "範囲の確認",
};
const activeStatuses = new Set(["running", "ready", "pausing"]);
// Auto approval passes the other gates; only these need a person, so they open the panel.
const attentionStatuses = new Set([
  "awaiting_manual_route",
  "awaiting_validation",
  "awaiting_escalation",
  "awaiting_handoff",
  "awaiting_consent",
  "awaiting_plan",
  "awaiting_fix",
  "uncertain",
  "blocked",
]);
const labels: Record<string, string> = {
  awaiting_validation: "検証待ち（プロジェクトのテスト未実施）",
  awaiting_consent: "送信範囲の確認",
  awaiting_plan: "実行案の確認",
  awaiting_fix: "修正の承認",
  awaiting_manual_route: "判断を採用できません",
  awaiting_escalation: "条件未達",
  awaiting_handoff: "固定モデルの作業が完了",
  paused: "停止中",
  uncertain: "結果不明・自動再送なし",
  completed: "完了",
  routed: "選択済み・実作業は通常ターンで実行",
  blocked: "停止・未合格",
  cancelled: "終了",
  running: "実行中",
  ready: "準備中",
  pausing: "停止を確認中",
};

export function JevWorkflowPanel({
  threadKey,
  submission,
  onCreated,
  onDismiss,
}: {
  threadKey: string;
  submission: JevSubmission | null;
  onCreated: (job: JevJob) => void | Promise<void>;
  onDismiss: () => void;
}) {
  const [bootstrap, setBootstrap] = useState<JevBootstrap | null>(null);
  const [detail, setDetail] = useState<JevDetail | null>(null);
  const [jobs, setJobs] = useState<JevJob[]>([]);
  const [files, setFiles] = useState("");
  const [requirements, setRequirements] = useState("");
  const [scenarios, setScenarios] = useState("");
  const [textOnly, setTextOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [fixPaths, setFixPaths] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  const mutex = useRef(false);
  const autoStartedNonce = useRef<string | null>(null);
  const createdNonce = useRef<string | null>(null);
  const mounted = useRef(true);
  const selectedJob = useRef<string | null>(null);
  const scopeRef = useRef<{ nonce: string; request: JevRequest } | null>(null);

  const load = async (id: string) => {
    selectedJob.current = id;
    const value = await jevRequest<JevDetail>(threadKey, "get", { id });
    if (mounted.current && selectedJob.current === id)
      setDetail((current) =>
        current?.job.id === value.job.id && current.job.version > value.job.version
          ? current
          : value,
      );
  };
  useEffect(() => {
    mounted.current = true;
    void Promise.all([
      jevRequest<JevBootstrap>(threadKey, "bootstrap"),
      jevRequest<JevJob[]>(threadKey, "list"),
    ])
      .then(([config, saved]) => {
        if (!mounted.current) return;
        setBootstrap(config);
        setJobs(saved);
        if (saved[0])
          void load(saved[0].id).catch((e: Error) => mounted.current && setError(e.message));
      })
      .catch((e: Error) => mounted.current && setError(e.message));
    return () => {
      mounted.current = false;
    };
  }, [threadKey]);
  useEffect(() => {
    if (!detail || !activeStatuses.has(detail.job.status)) return;
    const timer = window.setTimeout(() => {
      void load(detail.job.id).catch((e: Error) => mounted.current && setError(e.message));
    }, 700);
    return () => window.clearTimeout(timer);
  }, [detail]);
  const approvalKey = detail
    ? `${detail.job.id}:${detail.job.status}:${detail.job.data.current_hash}:${detail.job.data.plan_hash}:${detail.job.data.review_hash}`
    : "";
  useEffect(() => {
    setAck(false);
    setFixPaths([]);
  }, [approvalKey]);

  const perform = async (work: () => Promise<void>) => {
    if (mutex.current) return;
    mutex.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : "処理が停止しました。状態を確認してください。");
    } finally {
      mutex.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const create = () =>
    perform(async () => {
      if (!submission) return;
      // Retain the exact request + nonce after a lost create response. Never turn a retry into a new run.
      if (scopeRef.current?.nonce !== submission.nonce) {
        const request = textOnly
          ? await jevRequest<JevRequest>(threadKey, "decision_request", {
              task: submission.task,
              model_selection: submission.modelSelection ?? { model: "auto", effort: "auto" },
            })
          : {
              source: submission.source,
              task: submission.task,
              files: files
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean),
              mode: "demo" as const,
              model_selection: { model: "auto", effort: "auto" },
              auto_kind: true,
              requirements: requirements
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                  const split = line.indexOf(" | ");
                  if (split < 1)
                    throw new Error("合格条件は 相対パス | 必要な文字列 で入力してください。");
                  return { path: line.slice(0, split).trim(), contains: line.slice(split + 3) };
                }),
              ui_scenarios: scenarios.trim() ? (JSON.parse(scenarios) as unknown[]) : [],
            };
        await jevRequest(threadKey, "preview", { request });
        scopeRef.current = { nonce: submission.nonce, request };
      }
      const job = await jevRequest<JevJob>(threadKey, "create", scopeRef.current);
      if (!mounted.current) return;
      setJobs((current) => [job, ...current.filter((x) => x.id !== job.id)]);
      await load(job.id);
      if (!mounted.current) return;
      if (createdNonce.current !== submission.nonce) {
        await onCreated(job);
        createdNonce.current = submission.nonce;
      }
    });
  useEffect(() => {
    if (!submission || !bootstrap || !textOnly || autoStartedNonce.current === submission.nonce)
      return;
    autoStartedNonce.current = submission.nonce;
    void create();
  }, [submission?.nonce, bootstrap, textOnly]);
  const action = (name: string, fields: unknown = {}) =>
    perform(async () => {
      if (!detail) return;
      const job = detail.job;
      if (name === "stop") setJevHandoffState(job.id, "cancelled");
      await jevRequest(threadKey, "action", {
        id: job.id,
        version: job.version,
        action: name,
        fields,
      });
      await load(job.id);
    });
  const job = detail?.job;
  if (!submission && !job && !error) return null;
  if (!submission && job && detail && !error && !expanded && !attentionStatuses.has(job.status)) {
    return (
      <section
        aria-label="Jevワークフロー"
        data-jev-panel
        className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
      >
        <strong className="shrink-0">Jev</strong>
        <span className="shrink-0">
          {job.status === "routed"
            ? job.data.request.mode === "demo"
              ? "模擬の仮選択済み"
              : "実判定で選択済み"
            : (labels[job.status] ?? job.status)}
        </span>
        {job.data.plan && (
          <span className="shrink-0 text-muted-foreground">{job.data.plan.model}</span>
        )}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {job.status === "completed" &&
          detail.answer &&
          !(job.data.request.text_only && job.data.request.mode === "demo")
            ? detail.answer
            : job.data.request.task}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setExpanded(true)}>
          詳細
        </Button>
      </section>
    );
  }
  return (
    <section
      aria-label="Jevワークフロー"
      data-jev-panel
      className="mx-auto mb-3 max-h-[55vh] w-full max-w-3xl overflow-auto rounded-xl border border-border bg-background p-3 text-sm"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <strong>オート · Jev</strong>
        <span className="flex items-center gap-2 text-muted-foreground">
          {job?.data.request.mode === "live" || (submission && bootstrap?.decision_live_enabled)
            ? "TypeSafeの実判定 · 実作業は通常ターン"
            : "ローカルの模擬判断 · TypeSafe実判定は未有効"}
          {!submission && job && !attentionStatuses.has(job.status) && (
            <Button size="sm" variant="ghost" onClick={() => setExpanded(false)}>
              畳む
            </Button>
          )}
        </span>
      </div>
      {error && (
        <p role="alert" className="mb-2 text-destructive">
          {error}
        </p>
      )}
      {submission && (
        <div className="space-y-3">
          <p className="whitespace-pre-wrap break-words">{submission.task}</p>
          <p className="text-muted-foreground">
            入力文からモデルを選択し、会話のアクセス設定に従って指示を実行します。実判定は別途の有効化が必要です。判定は追加の権限を与えません。
          </p>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={textOnly}
              onChange={(e) => setTextOnly(e.target.checked)}
              disabled={busy || scopeRef.current?.nonce === submission.nonce}
            />
            モデルの選択には入力文のみを使う（実行は会話のアクセス設定に従う）
          </label>
          {!textOnly && (
            <>
              <p className="break-all text-muted-foreground">作業元: {submission.source}</p>
              <label className="block">
                対象ファイル（相対パス、1行1件）
                <Textarea
                  aria-label="対象ファイル"
                  value={files}
                  onChange={(e) => setFiles(e.target.value)}
                  disabled={busy}
                />
              </label>
              <label className="block">
                合格条件（相対パス | 必要な文字列、1行1件）
                <Textarea
                  aria-label="合格条件"
                  value={requirements}
                  onChange={(e) => setRequirements(e.target.value)}
                  disabled={busy}
                />
              </label>
              <details>
                <summary>画面の受入シナリオ</summary>
                <Textarea
                  aria-label="受入シナリオJSON"
                  value={scenarios}
                  onChange={(e) => setScenarios(e.target.value)}
                  placeholder="既存runner形式のJSON。実三観は測定証拠が必要です。"
                />
              </details>
              <p className="text-muted-foreground">
                指定ファイルを固定したコピー上で作業します。検査は構文と指定文字列です。対象プロジェクトの単体テスト・型チェック・ビルドはまだ実行しません。
              </p>
            </>
          )}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy || !bootstrap} onClick={create}>
              {textOnly
                ? busy
                  ? "モデルを選択中…"
                  : "同じ依頼の状態を確認"
                : "範囲を確認して模擬の作業を作成"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>
              戻る
            </Button>
          </div>
        </div>
      )}
      {!submission && job && detail && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <strong>{labels[job.status] ?? job.status}</strong>
            <span>{phaseLabels[job.data.phase] ?? job.data.phase}</span>
            {jobs.length > 1 && (
              <select
                aria-label="保存したAuto作業"
                value={job.id}
                disabled={busy}
                onChange={(e) => void perform(() => load(e.target.value))}
              >
                {jobs.map((x) => (
                  <option key={x.id} value={x.id}>
                    {new Date(x.created * 1000).toLocaleString()} ·{" "}
                    {x.data.request.task.slice(0, 30)}
                  </option>
                ))}
              </select>
            )}
          </div>
          <p className="whitespace-pre-wrap break-words">{job.data.request.task}</p>
          <p className="text-muted-foreground">
            今回の選択:{" "}
            {job.data.request.model_selection.model === "auto"
              ? "オート"
              : job.data.request.model_selection.model}{" "}
            {job.data.request.decision_only
              ? " · 判定専用（Jev内の実作業なし）"
              : ` · 修正 ${job.data.corrections}/1 · レビュー ${job.data.reviews}/2`}
          </p>
          {job.data.plan && job.data.request.decision_only && (
            <p>
              検証済みの選択: {job.data.plan.model} / {job.data.plan.effort}
              。判定結果は権限や作業の合格を与えません。
            </p>
          )}
          {job.data.plan && !job.data.request.decision_only && (
            <div>
              <p>
                Jevの選択: {job.data.plan.model} / {job.data.plan.effort} ·{" "}
                {job.data.plan.review_depth === "sankan"
                  ? "Sol 三観（金継ぎ・目付・軍配）"
                  : job.data.plan.review_depth === "code"
                    ? "Solコードレビュー"
                    : "機械検査"}
              </p>
              <p className="break-words text-muted-foreground">
                {[
                  job.data.plan.coordinator,
                  job.data.plan.worker,
                  job.data.plan.reviewer,
                  job.data.plan.final,
                ]
                  .filter(Boolean)
                  .map((x) => `${x!.model} (${x!.effort})`)
                  .join(" → ")}
              </p>
              {job.data.plan.promotions.map((x) => (
                <p key={x}>{x}</p>
              ))}
            </div>
          )}
          {job.data.error && <p role="alert">{job.data.error}</p>}
          <p aria-live="polite">{detail.events.at(-1)?.detail.message}</p>
          {job.status === "awaiting_consent" && (
            <>
              <p className="break-words">対象: {job.data.scope.allowed_paths.join(", ")}</p>
              <details>
                <summary>送信範囲・上限</summary>
                <pre className="whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(
                    { scope: job.data.scope, limits: job.data.request.limits },
                    null,
                    2,
                  )}
                </pre>
              </details>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                範囲を確認しました（模擬・外部送信なし）
              </label>
              <Button
                size="sm"
                disabled={busy || !ack}
                onClick={() =>
                  void action("consent", { ack: true, consent_hash: job.data.scope.consent_hash })
                }
              >
                模擬のJev判断を開始
              </Button>
            </>
          )}
          {job.status === "awaiting_plan" && (
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void action("approve_plan", { plan_hash: job.data.plan_hash })}
            >
              この実行案で模擬を進める
            </Button>
          )}
          {job.status === "awaiting_fix" && (
            <>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all text-xs">
                {JSON.stringify(job.data.artifacts.review, null, 2)}
              </pre>
              <p>修正を許可するファイルを選んでください。</p>
              {job.data.scope.allowed_paths.map((path) => (
                <label key={path} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={fixPaths.includes(path)}
                    onChange={(e) =>
                      setFixPaths((current) =>
                        e.target.checked ? [...current, path] : current.filter((x) => x !== path),
                      )
                    }
                  />
                  {path}
                </label>
              ))}
              <Button
                size="sm"
                disabled={busy || fixPaths.length === 0}
                onClick={() =>
                  void action("approve_fix", {
                    snapshot_hash: job.data.current_hash,
                    review_hash: job.data.review_hash,
                    paths: fixPaths,
                  })
                }
              >
                選択範囲の修正を承認（最大1巡）
              </Button>
            </>
          )}
          {job.status === "awaiting_escalation" && (
            <Button size="sm" disabled={busy} onClick={() => void action("escalate")}>
              上位の実行案を確認
            </Button>
          )}
          {job.status === "awaiting_manual_route" && (
            <p>Jevの判断が未確定です。原本を確認して新しい作業として送信してください。</p>
          )}
          {job.status === "routed" && (
            <p>
              モデルの選択を検証しました。実回答は通常の会話に表示されます。Jev内では作業・検査・レビューを行っていません。
            </p>
          )}
          {job.status === "completed" && (
            <>
              {detail.answer && <p className="whitespace-pre-wrap break-words">{detail.answer}</p>}
              <p className="break-all">成果物のコピー: {detail.copy_path}</p>
              <details>
                <summary>検査・レビュー・引継ぎの結果</summary>
                <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify(job.data.artifacts, null, 2)}
                </pre>
              </details>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {!["completed", "routed", "cancelled", "paused", "uncertain"].includes(job.status) && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void action("stop")}
              >
                停止
              </Button>
            )}
            {job.status === "paused" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void action("resume")}
              >
                保存状態から再開
              </Button>
            )}
            {job.status === "uncertain" && (
              <p>結果不明の呼び出しは再送できません。台帳を確認してください。</p>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void perform(() => load(job.id))}
            >
              状態を更新
            </Button>
          </div>
          <details>
            <summary>工程の記録</summary>
            <ul className="space-y-1">
              {detail.calls.map((call) => (
                <li key={call.stage}>
                  {call.stage} · {call.provider} · {call.status}
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}
    </section>
  );
}
