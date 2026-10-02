import { ApprovalRequestId, type ProviderApprovalDecision } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { approvalOptionPresentation, approvalPresentation } from "./approvalPresentation";
const base = { requestId: ApprovalRequestId.make("fixture"), createdAt: "2026-10-02T00:00:00Z" };
describe("Japanese approval purpose and decisions", () => {
  it("explains tests in Japanese while preserving the exact executable command", () => {
    const detail = 'npm test -- --runInBand /tmp/test-input; echo "$HOME"';
    const value = approvalPresentation({ ...base, requestKind: "command", detail });
    expect(value.purpose).toContain("テストを実行");
    expect(value.detail).toBe(detail);
  });
  it("translates an app access request and preserves its target", () => {
    expect(
      approvalPresentation({
        ...base,
        requestKind: "mcp-elicitation",
        detail: "Allow ChatGPT to use Safari?",
      }).detail,
    ).toBe("ChatGPTが Safari にアクセスすることを許可しますか？");
  });
  it.each<ProviderApprovalDecision>([
    "accept",
    "acceptForSession",
    "acceptAlways",
    "decline",
    "cancel",
  ])("preserves decision %s and its permission duration", (decision) => {
    const value = approvalOptionPresentation({
      decision,
      label: "Provider supplied English label",
    });
    expect(value.decision).toBe(decision);
    expect(value.label).toMatch(/[一-龯]/);
    if (decision === "acceptForSession") expect(value.label).toContain("セッション中");
    if (decision === "acceptAlways") expect(value.label).toContain("今後");
  });
  it("keeps unknown warnings available without inventing an exact translation", () => {
    const value = approvalOptionPresentation({
      decision: "accept",
      label: "Approve",
      warning: "Unknown provider warning",
    });
    expect(value.warning).toContain("原文");
    expect(value.originalWarning).toBe("Unknown provider warning");
  });
});
