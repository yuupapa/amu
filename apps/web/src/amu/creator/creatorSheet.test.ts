import type { CreatorProposal, CreatorSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { creatorSheetPhase, formatCreatorTime } from "./creatorSheet";

const PROPOSAL_ID = "33333333-3333-4333-8333-333333333333";
const COMMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const proposal = (send: Record<string, unknown> | null = null) =>
  ({
    id: PROPOSAL_ID,
    items: [{ commentId: COMMENT_ID }],
    send:
      send === null
        ? null
        : { state: "sending", reason: null, attempts: 0, haltRequested: false, ...send },
  }) as unknown as CreatorProposal;

const snapshot = (
  proposals: CreatorProposal[],
  comment: Record<string, unknown> = {},
): CreatorSnapshot =>
  ({
    projectId: "a".repeat(32),
    revision: 1,
    proposals,
    comments: [{ id: COMMENT_ID, status: "draft", sentMessageId: null, ...comment }],
  }) as unknown as CreatorSnapshot;

const phase = (
  snap: CreatorSnapshot | null,
  options: {
    submitted?: boolean;
    result?: Record<string, unknown> | null;
    seenLive?: boolean;
  } = {},
) =>
  creatorSheetPhase({
    snapshot: snap,
    pinned: proposal(),
    submitted: options.submitted ?? false,
    result: (options.result ?? null) as never,
    seenLive: options.seenLive ?? true,
  });

describe("creatorSheetPhase", () => {
  it("offers review from the propose answer until the user sends", () => {
    // The propose answer can come before the snapshot that lists the proposal.
    expect(phase(null, { seenLive: false })).toEqual({ kind: "review" });
    expect(phase(snapshot([]), { seenLive: false })).toEqual({ kind: "review" });
    expect(phase(snapshot([proposal()]))).toEqual({ kind: "review" });
    expect(phase(snapshot([proposal()]), { submitted: true })).toEqual({
      kind: "sending",
      checking: false,
    });
  });

  it("keeps showing 送信中 even if the request answered accepted, until the snapshot settles", () => {
    expect(
      phase(snapshot([proposal({ state: "sending" })]), {
        submitted: true,
        result: { state: "accepted", reason: null },
      }),
    ).toEqual({ kind: "sending", checking: false });
    expect(phase(snapshot([proposal({ state: "sending", attempts: 1 })]))).toEqual({
      kind: "sending",
      checking: true,
    });
  });

  it("reports stuck, halted, and conflict from the live send record", () => {
    expect(phase(snapshot([proposal({ state: "stuck" })]))).toEqual({ kind: "stuck" });
    expect(
      phase(snapshot([proposal({ state: "halted", reason: "unverified: in_flight" })])),
    ).toEqual({ kind: "halted", unverified: true });
    expect(phase(snapshot([proposal({ state: "conflict" })]))).toEqual({ kind: "conflict" });
  });

  it("tells a finished send from a cancelled proposal", () => {
    const sent = snapshot([], { status: "sent", sentMessageId: `creator:${PROPOSAL_ID}` });
    expect(phase(sent, { submitted: true })).toEqual({ kind: "sent" });
    expect(
      phase(snapshot([]), { submitted: true, result: { state: "rejected", reason: "halted" } }),
    ).toEqual({ kind: "failed", reason: "halted" });
    expect(phase(snapshot([]))).toEqual({ kind: "gone" });
    expect(phase(sent, { seenLive: false })).toEqual({ kind: "sent" });
  });
});

describe("formatCreatorTime", () => {
  it("formats minutes and tenths", () => {
    expect(formatCreatorTime(76.25)).toBe("1:16.3");
    expect(formatCreatorTime(5)).toBe("0:05.0");
    expect(formatCreatorTime(59.96)).toBe("1:00.0");
  });
});
