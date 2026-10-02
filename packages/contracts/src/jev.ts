import * as Schema from "effect/Schema";

export const JevRpcRequest = Schema.Struct({
  method: Schema.Literals([
    "bootstrap",
    "preview",
    "create",
    "list",
    "get",
    "action",
    "text_request",
    "decision_request",
  ]),
  thread: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type JevBinding = { model: string; provider: string; effort: string; role: string };
export type JevPlan = {
  route: string;
  model: string;
  effort: string;
  review_depth: string;
  manual_fixed?: boolean;
  worker: JevBinding;
  coordinator?: JevBinding;
  reviewer?: JevBinding;
  final?: JevBinding;
  promotions: string[];
};
export type JevRequest = {
  source: string;
  task: string;
  files: string[];
  new_files?: string[];
  mode: "demo" | "live";
  requirements: { path: string; contains: string }[];
  model_selection: { model: string; effort: string };
  text_only?: boolean;
  decision_only?: boolean;
  auto_kind?: boolean;
  limits?: Record<string, number>;
  ui_scenarios?: unknown[];
};
export type JevJob = {
  id: string;
  version: number;
  status: string;
  created: number;
  data: {
    request: JevRequest;
    phase: string;
    plan: JevPlan | null;
    plan_hash?: string;
    review_hash?: string;
    current_hash: string;
    corrections: number;
    reviews: number;
    error: string | null;
    scope: {
      consent_hash: string;
      snapshot_hash: string;
      allowed_paths: string[];
      disclosure: Record<string, unknown>;
    };
    artifacts: Record<string, unknown>;
  };
};
export type JevDetail = {
  job: JevJob;
  events: { kind: string; detail: { message?: string } }[];
  calls: { stage: string; status: string; provider: string }[];
  copy_path: string;
  answer?: string;
};
export type JevBootstrap = {
  live_enabled: boolean;
  decision_live_enabled?: boolean;
  fixture: string;
  mode: string;
  capabilities: Record<string, { provider: string; efforts: string[] }>;
};
