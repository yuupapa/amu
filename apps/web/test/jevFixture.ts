import type { JevJob } from "@t3tools/contracts";
export const jevFixtureJob: JevJob = {
  id: "fictional-auto",
  version: 1,
  status: "routed",
  created: 0,
  data: {
    request: {
      source: "/tmp/fictional",
      files: ["回答.md"],
      task: "架空の一文を返してください",
      mode: "demo",
      text_only: true,
      decision_only: true,
      requirements: [],
      model_selection: { model: "auto", effort: "auto" },
    },
    phase: "complete",
    plan: {
      route: "simple",
      model: "gpt-6-luna",
      effort: "low",
      review_depth: "mechanical",
      worker: { model: "gpt-6-luna", effort: "low", provider: "codex", role: "implement" },
      promotions: [],
    },
    current_hash: "fixture-hash",
    corrections: 0,
    reviews: 0,
    error: null,
    scope: {
      consent_hash: "fixture-consent",
      snapshot_hash: "fixture-snapshot",
      allowed_paths: ["回答.md"],
      disclosure: {},
    },
    plan_hash: "fixture-plan",
    artifacts: {
      decision: { mode: "demo", plan_hash: "fixture-plan", native_handoff: true, model_calls: 0 },
    },
  },
};
