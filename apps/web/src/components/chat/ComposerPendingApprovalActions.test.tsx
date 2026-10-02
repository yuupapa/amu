import { ApprovalRequestId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

describe("ComposerPendingApprovalActions", () => {
  it("keeps the main decisions visible and secondary decisions in the menu", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-1")}
        isResponding={false}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain(">許可しない<");
    expect(markup).toContain(">今回だけ許可<");
    expect(markup).not.toContain(">取り消す<");
    expect(markup).not.toContain("Always allow this session");
  });

  it("keeps secondary provider labels out of the compact action row", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-safari")}
        isResponding={false}
        options={[
          { decision: "decline", label: "Decline" },
          { decision: "acceptAlways", label: "Always allow Safari" },
          { decision: "accept", label: "Approve" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).not.toContain("Always allow Safari");
    expect(markup).toContain(">今回だけ許可<");
    expect(markup).not.toContain("Always allow this session");
  });

  it("translates provider decisions without changing their scope", () => {
    const markup = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-1")}
        isResponding={false}
        options={[
          { decision: "accept", label: "Allow once" },
          { decision: "decline", label: "Deny" },
        ]}
        onRespondToApproval={async () => undefined}
      />,
    );

    expect(markup).toContain(">今回だけ許可<");
    expect(markup).toContain(">許可しない<");
    expect(markup).not.toContain(">Approve<");
    expect(markup).not.toContain(">Decline<");
  });
});
