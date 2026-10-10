import type { CreatorProposal, CreatorSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  approveAndSend,
  creatorAttentionProposal,
  creatorSheetPhase,
  creatorShotIsStale,
  formatCreatorTime,
} from "./creatorSheet";
import { CREATOR_PAGE_CHANGED } from "./creatorText";

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

describe("creatorSheetPhase without a snapshot", () => {
  it("never waits forever: it shows the proposal, or the refusal the server answered", () => {
    expect(phase(null)).toEqual({ kind: "review" });
    expect(phase(null, { submitted: true })).toEqual({ kind: "sending", checking: false });
    expect(
      phase(null, { submitted: true, result: { state: "rejected", reason: "thread_archived" } }),
    ).toEqual({ kind: "failed", reason: "thread_archived" });
  });
});

describe("creatorAttentionProposal", () => {
  it("finds a send that needs the user, unless its sheet is already open", () => {
    const pending = proposal();
    const stuck = { ...proposal({ state: "stuck" }), id: "44444444-4444-4444-8444-444444444444" };
    expect(creatorAttentionProposal(snapshot([pending]), null)).toBeNull();
    expect(creatorAttentionProposal(snapshot([pending, stuck as never]), null)).toBe(stuck);
    expect(creatorAttentionProposal(snapshot([stuck as never]), stuck.id as never)).toBeNull();
    for (const state of ["sending", "halted", "conflict"]) {
      const live = proposal({ state });
      expect(creatorAttentionProposal(snapshot([live]), null)).toBe(live);
    }
    expect(creatorAttentionProposal(null, null)).toBeNull();
  });
});

describe("approveAndSend", () => {
  const pinned = { ...proposal(), revisionKey: "key-1" } as unknown as CreatorProposal;
  const BINDING = "11111111-1111-4111-8111-111111111111" as never;

  it("sends with the epoch main returned at approval", async () => {
    const approvals: unknown[] = [];
    const sends: unknown[] = [];
    const outcome = await approveAndSend({
      tabId: "tab",
      generation: 4,
      bindingId: BINDING,
      proposal: pinned,
      approve: async (input) => {
        approvals.push(input);
        return { ok: true, epoch: 7 };
      },
      confirmSend: async (input) => {
        sends.push(input);
        return { ok: true, value: { proposalId: pinned.id, state: "accepted", reason: null } };
      },
    });
    expect(approvals).toEqual([{ tabId: "tab", generation: 4, proposalId: PROPOSAL_ID }]);
    expect(sends).toEqual([
      { bindingId: BINDING, epoch: 7, proposalId: PROPOSAL_ID, revisionKey: "key-1" },
    ]);
    expect(outcome).toEqual({
      ok: true,
      result: { proposalId: PROPOSAL_ID, state: "accepted", reason: null },
    });
  });

  it("does not send when main refuses the approval", async () => {
    let sent = false;
    const outcome = await approveAndSend({
      tabId: "tab",
      generation: 4,
      bindingId: BINDING,
      proposal: pinned,
      approve: async () => ({ ok: false, reason: "stale_generation" }),
      confirmSend: async () => {
        sent = true;
        return { ok: true, value: null as never };
      },
    });
    expect(sent).toBe(false);
    expect(outcome).toEqual({ ok: false, approved: false, message: CREATOR_PAGE_CHANGED });
  });

  it("reports a server refusal in Japanese", async () => {
    const outcome = await approveAndSend({
      tabId: "tab",
      generation: 4,
      bindingId: BINDING,
      proposal: pinned,
      approve: async () => ({ ok: true, epoch: 2 }),
      confirmSend: async () => ({
        ok: false,
        error: { _tag: "CreatorOperationError", code: "stale_epoch", detail: "stale_epoch" },
      }),
    });
    expect(outcome).toEqual({ ok: false, approved: true, message: CREATOR_PAGE_CHANGED });
  });
});

describe("formatCreatorTime", () => {
  it("formats minutes and tenths", () => {
    expect(formatCreatorTime(76.25)).toBe("1:16.3");
    expect(formatCreatorTime(5)).toBe("0:05.0");
    expect(formatCreatorTime(59.96)).toBe("1:00.0");
  });
});

describe("creatorShotIsStale", () => {
  const item = (shot: object | null) =>
    ({ commentId: COMMENT_ID, shot }) as unknown as CreatorProposal["items"][number];
  const shot = { commentId: COMMENT_ID, revision: 2 };

  it("warns when the pinned image is from before the place was changed", () => {
    expect(creatorShotIsStale(snapshot([], { shotStale: true }), item(shot))).toBe(true);
  });

  it("does not warn for a current image, no image, or an unknown comment", () => {
    expect(creatorShotIsStale(snapshot([], { shotStale: false }), item(shot))).toBe(false);
    expect(creatorShotIsStale(snapshot([], {}), item(shot))).toBe(false);
    expect(creatorShotIsStale(snapshot([], { shotStale: true }), item(null))).toBe(false);
    expect(creatorShotIsStale(null, item(shot))).toBe(false);
  });
});
