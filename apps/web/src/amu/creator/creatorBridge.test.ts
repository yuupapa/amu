import type {
  CreatorBindingId,
  CreatorComment,
  CreatorCommentId,
  CreatorProposal,
  CreatorProposalId,
  CreatorSnapshot,
  DesktopPreviewCreatorEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CREATOR_PROJECT_REVISION,
  createCreatorBridge,
  createCreatorSettingGate,
  type CreatorBridgeMain,
  type CreatorBridgeRpc,
  type CreatorBridgeView,
} from "./creatorBridge";

const TAB = "runtime-tab-1";
const BINDING = "11111111-1111-4111-8111-111111111111" as CreatorBindingId;
const COMMENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as CreatorCommentId;
const COMMENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as CreatorCommentId;
const PROPOSAL = "33333333-3333-4333-8333-333333333333" as CreatorProposalId;

const comment = (
  id: CreatorCommentId,
  revision: number,
  overrides: Partial<CreatorComment> = {},
): CreatorComment =>
  ({
    id,
    number: 1,
    timeSec: 1,
    place: null,
    comment: "text",
    revision,
    status: "draft",
    shot: null,
    projectRevision: CREATOR_PROJECT_REVISION,
    createdAt: "2026-10-10T00:00:00.000Z",
    sentAt: null,
    sentMessageId: null,
    sentVersion: null,
    resolvedNote: null,
    ...overrides,
  }) as CreatorComment;

const snapshot = (revision: number, comments: CreatorComment[] = []): CreatorSnapshot =>
  ({ projectId: "a".repeat(32), revision, comments, proposals: [] }) as unknown as CreatorSnapshot;

const png = (byte: number) => new Uint8Array([byte, byte, byte]);

type Call = { readonly method: string; readonly input: Record<string, unknown> };

/** Records every RPC; each method answers from `answers` (default: success). */
function harness(
  options: {
    readonly answers?: Partial<
      Record<keyof CreatorBridgeRpc, (input: Record<string, unknown>) => unknown>
    >;
    readonly register?: CreatorBridgeMain["registerCreatorSession"];
    readonly push?: (state: unknown) => boolean;
    readonly now?: () => number;
    readonly draftKeys?: Map<string, CreatorCommentId>;
    readonly tabExists?: () => boolean;
  } = {},
) {
  const calls: Call[] = [];
  const pushes: unknown[] = [];
  const registers: string[] = [];
  const views: CreatorBridgeView[] = [];
  let nextRevision = 1;
  const defaults: Record<keyof CreatorBridgeRpc, (input: Record<string, unknown>) => unknown> = {
    setEpoch: () => undefined,
    saveDraft: () => comment(COMMENT_A, nextRevision++),
    updateComment: (input) =>
      comment(input["commentId"] as CreatorCommentId, (input["expectedRevision"] as number) + 1),
    setPlace: (input) =>
      comment(input["commentId"] as CreatorCommentId, (input["expectedRevision"] as number) + 1),
    attachShot: (input) =>
      comment(input["commentId"] as CreatorCommentId, (input["expectedRevision"] as number) + 1),
    deleteComment: () => undefined,
    propose: () => ({ id: PROPOSAL }) as unknown as CreatorProposal,
    cancelProposal: () => undefined,
    confirmByUser: (input) => comment(input["commentId"] as CreatorCommentId, 9),
  };
  const rpc = Object.fromEntries(
    (Object.keys(defaults) as Array<keyof CreatorBridgeRpc>).map((method) => [
      method,
      async (input: Record<string, unknown>) => {
        calls.push({ method, input });
        // Let a concurrently queued event try to overtake this call.
        await Promise.resolve();
        await Promise.resolve();
        const answer = (options.answers?.[method] ?? defaults[method])(input);
        return answer instanceof Error
          ? { ok: false as const, error: answer }
          : { ok: true as const, value: answer };
      },
    ]),
  ) as unknown as CreatorBridgeRpc;
  const main: CreatorBridgeMain = {
    registerCreatorSession:
      options.register ??
      (async (tabId) => {
        registers.push(tabId);
        return { ok: true, epoch: 1, generation: 1 };
      }),
    pushCreatorState: async (_tabId, state) => {
      const accepted = options.push?.(state) ?? true;
      if (accepted) pushes.push(state);
      return accepted;
    },
  };
  const bridge = createCreatorBridge({
    tabId: TAB,
    bindingId: BINDING,
    rpc,
    main,
    now: options.now ?? (() => 0),
    ...(options.draftKeys ? { draftKeys: options.draftKeys } : {}),
    tabExists: options.tabExists ?? (() => true),
    onChange: (view) => views.push(view),
  });
  return { bridge, calls, pushes, registers, views };
}

const event = (
  kind: string,
  epoch: number,
  extra: Record<string, unknown> = {},
): DesktopPreviewCreatorEvent =>
  ({
    tabId: TAB,
    bindingId: BINDING,
    epoch,
    kind,
    ...extra,
  }) as unknown as DesktopPreviewCreatorEvent;

const guest = (kind: string, epoch: number, payload: unknown) =>
  event(kind, epoch, { generation: 1, payload });

const shot = (epoch: number, extra: Record<string, unknown>) =>
  event("shot", epoch, {
    generation: 1,
    timeSec: 1,
    place: null,
    width: 3,
    height: 1,
    ...extra,
  });

/** Brings the bridge to an active session at `epoch`. */
async function activate(h: ReturnType<typeof harness>, epoch = 1, generation = 1) {
  await h.bridge.handleMainEvent(event("activated", epoch, { generation }));
}

const methods = (calls: readonly Call[]) => calls.map((call) => call.method);

describe("creatorBridge", () => {
  it("relays activation to the server and only then exposes the epoch for subscribing", async () => {
    const h = harness();
    await activate(h, 3, 2);
    expect(h.calls).toEqual([
      { method: "setEpoch", input: { bindingId: BINDING, epoch: 3, generation: 2 } },
    ]);
    expect(h.bridge.view()).toMatchObject({ epoch: 3, generation: 2 });
  });

  it("drops main events whose epoch is older than the newest seen", async () => {
    const h = harness();
    await activate(h, 2);
    await h.bridge.handleMainEvent(
      guest("draft", 1, { requestId: "r1", timeSec: 1, comment: "x", place: null }),
    );
    await h.bridge.handleMainEvent(event("activated", 1, { generation: 5 }));
    await h.bridge.handleMainEvent(event("revoked", 1, { reason: "navigation" }));
    expect(methods(h.calls)).toEqual(["setEpoch"]);
    expect(h.bridge.view()).toMatchObject({ epoch: 2, generation: 1 });
  });

  it("ignores events for another tab or another binding", async () => {
    const h = harness();
    await activate(h);
    await h.bridge.handleMainEvent({
      ...guest("delete", 1, { commentId: COMMENT_A }),
      tabId: "other-tab",
    } as DesktopPreviewCreatorEvent);
    await h.bridge.handleMainEvent({
      ...guest("delete", 1, { commentId: COMMENT_A }),
      bindingId: "22222222-2222-4222-8222-222222222222",
    } as DesktopPreviewCreatorEvent);
    expect(methods(h.calls)).toEqual(["setEpoch"]);
  });

  it("revocation clears the generation, closes the sheet and registers again", async () => {
    const h = harness();
    await activate(h);
    await h.bridge.handleMainEvent(guest("propose", 1, { commentIds: [COMMENT_A] }));
    expect(h.bridge.view().sheetProposalId).toBe(PROPOSAL);
    await h.bridge.handleMainEvent(event("revoked", 2, { reason: "navigation" }));
    expect(h.calls.at(-1)).toEqual({
      method: "setEpoch",
      input: { bindingId: BINDING, epoch: 2, generation: null },
    });
    expect(h.bridge.view()).toMatchObject({ generation: null, sheetProposalId: null });
    expect(h.registers).toEqual([TAB]);
  });

  it("does not register again after a revocation it did not want to recover from", async () => {
    const h = harness();
    await activate(h);
    await h.bridge.handleMainEvent(event("revoked", 2, { reason: "revoke-all" }));
    await h.bridge.handleMainEvent(event("revoked", 3, { reason: "tab-closed" }));
    expect(h.registers).toEqual([]);
  });

  it("creates one comment for a repeated draft request id and passes the text unchanged", async () => {
    const h = harness();
    await activate(h);
    const text = "  柱を  太く\n\tして ";
    const first = h.bridge.handleMainEvent(
      guest("draft", 1, { requestId: "r1", timeSec: 76.2, comment: text, place: null }),
    );
    const second = h.bridge.handleMainEvent(
      guest("draft", 1, { requestId: "r1", timeSec: 76.2, comment: "newer", place: null }),
    );
    await Promise.all([first, second]);
    await h.bridge.handleMainEvent(
      guest("draft", 1, { requestId: "r1", timeSec: 76.2, comment: "again", place: null }),
    );
    const drafts = h.calls.filter((call) => call.method === "saveDraft");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.input).toEqual({
      bindingId: BINDING,
      epoch: 1,
      timeSec: 76.2,
      comment: text,
      place: null,
      projectRevision: CREATOR_PROJECT_REVISION,
    });
  });

  it("passes edited text through unchanged", async () => {
    const h = harness();
    await activate(h);
    const text = " 全角　スペース ";
    await h.bridge.handleMainEvent(
      guest("update", 1, { commentId: COMMENT_A, expectedRevision: 4, comment: text }),
    );
    expect(h.calls.at(-1)).toEqual({
      method: "updateComment",
      input: {
        bindingId: BINDING,
        epoch: 1,
        commentId: COMMENT_A,
        expectedRevision: 4,
        comment: text,
      },
    });
  });

  it("holds a draft shot until its draft arrives, then attaches it to the new comment", async () => {
    const h = harness();
    await activate(h);
    await h.bridge.handleMainEvent(
      shot(1, { requestId: "r1", purpose: "draft", commentId: null, png: png(7) }),
    );
    expect(methods(h.calls)).toEqual(["setEpoch"]);
    await h.bridge.handleMainEvent(
      guest("draft", 1, { requestId: "r1", timeSec: 1, comment: "x", place: null }),
    );
    expect(methods(h.calls)).toEqual(["setEpoch", "saveDraft", "attachShot"]);
    expect(h.calls[2]!.input).toMatchObject({
      commentId: COMMENT_A,
      expectedRevision: 1,
      png: png(7),
    });
  });

  it("attaches a draft shot that arrives after its draft at the comment's current revision", async () => {
    const h = harness();
    await activate(h);
    await h.bridge.handleMainEvent(
      guest("draft", 1, { requestId: "r1", timeSec: 1, comment: "x", place: null }),
    );
    await h.bridge.handleMainEvent(
      guest("update", 1, { commentId: COMMENT_A, expectedRevision: 1, comment: "xy" }),
    );
    await h.bridge.handleMainEvent(
      shot(1, { requestId: "r1", purpose: "draft", commentId: null, png: png(1) }),
    );
    expect(methods(h.calls)).toEqual(["setEpoch", "saveDraft", "updateComment", "attachShot"]);
    expect(h.calls[3]!.input).toMatchObject({ commentId: COMMENT_A, expectedRevision: 2 });
  });

  it("drops draft shots that never get a draft (after 60 s, at most 10 kept)", async () => {
    let now = 0;
    const h = harness({ now: () => now });
    await activate(h);
    await h.bridge.handleMainEvent(
      shot(1, { requestId: "late", purpose: "draft", commentId: null, png: png(1) }),
    );
    for (let index = 0; index < 11; index += 1) {
      await h.bridge.handleMainEvent(
        shot(1, { requestId: `r${index}`, purpose: "draft", commentId: null, png: png(2) }),
      );
    }
    now = 61_000;
    // r10 is still buffered only if younger than 60 s: re-buffer one now.
    await h.bridge.handleMainEvent(
      shot(1, { requestId: "fresh", purpose: "draft", commentId: null, png: png(3) }),
    );
    for (const requestId of ["late", "r0", "r5", "fresh"]) {
      await h.bridge.handleMainEvent(
        guest("draft", 1, { requestId, timeSec: 1, comment: requestId, place: null }),
      );
    }
    const attached = h.calls.filter((call) => call.method === "attachShot");
    expect(attached).toHaveLength(1);
    expect(attached[0]!.input).toMatchObject({ png: png(3) });
  });

  it("orders a place before its shot and attaches at the revision setPlace returned", async () => {
    const h = harness({
      answers: {
        setPlace: (input) => comment(input["commentId"] as CreatorCommentId, 12),
      },
    });
    await activate(h);
    const place = {
      x: 0.5,
      y: 0.5,
      compositionFile: null,
      elementSelector: null,
      elementLabel: null,
    };
    const placed = h.bridge.handleMainEvent(
      guest("place", 1, { requestId: "p1", commentId: COMMENT_B, expectedRevision: 3, place }),
    );
    const shotted = h.bridge.handleMainEvent(
      shot(1, { requestId: "p1", purpose: "place", commentId: COMMENT_B, png: png(9) }),
    );
    await Promise.all([placed, shotted]);
    expect(methods(h.calls)).toEqual(["setEpoch", "setPlace", "attachShot"]);
    expect(h.calls[2]!.input).toMatchObject({ commentId: COMMENT_B, expectedRevision: 12 });
  });

  it("holds a place shot that overtakes its place until setPlace is acknowledged", async () => {
    const h = harness({
      answers: {
        setPlace: (input) => comment(input["commentId"] as CreatorCommentId, 20),
      },
    });
    await activate(h);
    await h.bridge.handleMainEvent(
      shot(1, { requestId: "p1", purpose: "place", commentId: COMMENT_B, png: png(9) }),
    );
    expect(methods(h.calls)).toEqual(["setEpoch"]);
    await h.bridge.handleMainEvent(
      guest("place", 1, {
        requestId: "p1",
        commentId: COMMENT_B,
        expectedRevision: 3,
        place: null,
      }),
    );
    expect(methods(h.calls)).toEqual(["setEpoch", "setPlace", "attachShot"]);
    expect(h.calls[2]!.input).toMatchObject({ expectedRevision: 20 });
  });

  it("pairs a place shot with its own place: a refused place drops its shot", async () => {
    const stale = Object.assign(new Error("stale"), {
      _tag: "CreatorOperationError",
      code: "stale_revision",
      detail: "stale_revision",
    });
    let placeCalls = 0;
    const h = harness({
      answers: {
        setPlace: (input) => {
          placeCalls += 1;
          return placeCalls === 1 ? stale : comment(input["commentId"] as CreatorCommentId, 30);
        },
      },
    });
    await activate(h);
    await h.bridge.handleMainEvent(
      guest("place", 1, {
        requestId: "p1",
        commentId: COMMENT_B,
        expectedRevision: 3,
        place: null,
      }),
    );
    await h.bridge.handleMainEvent(
      shot(1, { requestId: "p1", purpose: "place", commentId: COMMENT_B, png: png(1) }),
    );
    await h.bridge.handleMainEvent(
      guest("place", 1, {
        requestId: "p2",
        commentId: COMMENT_B,
        expectedRevision: 4,
        place: null,
      }),
    );
    await h.bridge.handleMainEvent(
      shot(1, { requestId: "p2", purpose: "place", commentId: COMMENT_B, png: png(2) }),
    );
    const attached = h.calls.filter((call) => call.method === "attachShot");
    expect(attached).toHaveLength(1);
    expect(attached[0]!.input).toMatchObject({ expectedRevision: 30, png: png(2) });
  });

  it("does not hand a later place's shot to an earlier place whose capture was lost", async () => {
    let revision = 40;
    const h = harness({
      answers: {
        setPlace: (input) => comment(input["commentId"] as CreatorCommentId, ++revision),
      },
    });
    await activate(h);
    await h.bridge.handleMainEvent(
      guest("place", 1, {
        requestId: "p1",
        commentId: COMMENT_B,
        expectedRevision: 3,
        place: null,
      }),
    );
    // p1's capture never arrives. A shot from another request is not p1's.
    await h.bridge.handleMainEvent(
      shot(1, { requestId: "p9", purpose: "place", commentId: COMMENT_B, png: png(9) }),
    );
    expect(methods(h.calls)).toEqual(["setEpoch", "setPlace"]);
    await h.bridge.handleMainEvent(
      guest("place", 1, {
        requestId: "p2",
        commentId: COMMENT_B,
        expectedRevision: 41,
        place: null,
      }),
    );
    await h.bridge.handleMainEvent(
      shot(1, { requestId: "p2", purpose: "place", commentId: COMMENT_B, png: png(2) }),
    );
    const attached = h.calls.filter((call) => call.method === "attachShot");
    expect(attached).toHaveLength(1);
    expect(attached[0]!.input).toMatchObject({ expectedRevision: 42, png: png(2) });
  });

  it("keeps at most 200 draft keys, shared with a later bridge for the same binding", async () => {
    const store = new Map<string, CreatorCommentId>();
    const h = harness({ draftKeys: store });
    await activate(h);
    for (let index = 0; index < 201; index += 1) {
      await h.bridge.handleMainEvent(
        guest("draft", 1, { requestId: `r${index}`, timeSec: 1, comment: "x", place: null }),
      );
    }
    expect(store.size).toBe(200);
    expect(store.has("r0")).toBe(false);
    expect(store.has("r200")).toBe(true);
    h.bridge.dispose();

    const again = harness({ draftKeys: store });
    await activate(again);
    await again.bridge.handleMainEvent(
      guest("draft", 1, { requestId: "r200", timeSec: 1, comment: "x", place: null }),
    );
    expect(methods(again.calls)).toEqual(["setEpoch"]);
  });

  it("clears the draft keys when main ends the session for good", async () => {
    const store = new Map<string, CreatorCommentId>();
    const h = harness({ draftKeys: store });
    await activate(h);
    await h.bridge.handleMainEvent(
      guest("draft", 1, { requestId: "r1", timeSec: 1, comment: "x", place: null }),
    );
    expect(store.size).toBe(1);
    await h.bridge.handleMainEvent(event("revoked", 2, { reason: "tab-closed" }));
    expect(store.size).toBe(0);
  });

  it("registers again after a destroyed guest only while the tab still exists", async () => {
    const kept = harness({ tabExists: () => true });
    await activate(kept);
    await kept.bridge.handleMainEvent(event("revoked", 2, { reason: "destroyed" }));
    expect(kept.registers).toEqual([TAB]);

    const gone = harness({ tabExists: () => false });
    await activate(gone);
    await gone.bridge.handleMainEvent(event("revoked", 2, { reason: "destroyed" }));
    await gone.bridge.register();
    expect(gone.registers).toEqual([]);
  });

  it("reopens the sheet for a proposal from the snapshot and keeps the last snapshot", async () => {
    const h = harness();
    await activate(h);
    const live = snapshot(3);
    await h.bridge.handleSnapshot(live);
    expect(h.bridge.view().snapshot).toBe(live);
    const proposal = { id: PROPOSAL } as unknown as CreatorProposal;
    h.bridge.openSheet(proposal);
    expect(h.bridge.view().sheetProposal).toBe(proposal);
    expect(h.views.at(-1)?.sheetProposalId).toBe(PROPOSAL);
  });

  it("maps the remaining guest messages to their RPCs", async () => {
    const h = harness();
    await activate(h);
    await h.bridge.handleMainEvent(guest("delete", 1, { commentId: COMMENT_A }));
    await h.bridge.handleMainEvent(guest("cancel", 1, { proposalId: PROPOSAL }));
    await h.bridge.handleMainEvent(guest("confirm-by-user", 1, { commentId: COMMENT_B }));
    await h.bridge.handleMainEvent(guest("delete", 1, { commentId: "not-an-id" }));
    expect(h.calls.slice(1)).toEqual([
      { method: "deleteComment", input: { bindingId: BINDING, epoch: 1, commentId: COMMENT_A } },
      { method: "cancelProposal", input: { bindingId: BINDING, epoch: 1, proposalId: PROPOSAL } },
      { method: "confirmByUser", input: { bindingId: BINDING, epoch: 1, commentId: COMMENT_B } },
    ]);
  });

  it("opens the confirm sheet for the proposal a propose event created", async () => {
    const h = harness();
    await activate(h);
    await h.bridge.handleMainEvent(guest("propose", 1, { commentIds: [COMMENT_A, COMMENT_B] }));
    expect(h.calls.at(-1)).toEqual({
      method: "propose",
      input: { bindingId: BINDING, epoch: 1, commentIds: [COMMENT_A, COMMENT_B] },
    });
    expect(h.bridge.view().sheetProposalId).toBe(PROPOSAL);
    expect(h.views.at(-1)?.sheetProposalId).toBe(PROPOSAL);
    h.bridge.closeSheet();
    expect(h.bridge.view().sheetProposalId).toBeNull();
  });

  it("pushes server state with draftKeys and the project revision only when it changed", async () => {
    const h = harness();
    await activate(h);
    await h.bridge.handleSnapshot(snapshot(1));
    await h.bridge.handleSnapshot(snapshot(1));
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]).toMatchObject({
      revision: 1,
      draftKeys: {},
      projectRevision: CREATOR_PROJECT_REVISION,
      notice: null,
    });
    await h.bridge.handleMainEvent(
      guest("draft", 1, { requestId: "r1", timeSec: 1, comment: "x", place: null }),
    );
    // The new mapping alone is a change worth pushing.
    expect(h.pushes).toHaveLength(2);
    expect(h.pushes[1]).toMatchObject({ draftKeys: { r1: COMMENT_A } });
    await h.bridge.handleSnapshot(snapshot(2, [comment(COMMENT_A, 1)]));
    expect(h.pushes).toHaveLength(3);
    await h.bridge.handleSnapshot(snapshot(2, [comment(COMMENT_A, 1)]));
    expect(h.pushes).toHaveLength(3);
  });

  it("pushes the same state again after a new activation and for a repeated draft", async () => {
    const h = harness();
    await activate(h);
    await h.bridge.handleSnapshot(snapshot(1));
    await h.bridge.handleMainEvent(
      guest("draft", 1, { requestId: "r1", timeSec: 1, comment: "x", place: null }),
    );
    expect(h.pushes).toHaveLength(2);
    await h.bridge.handleMainEvent(
      guest("draft", 1, { requestId: "r1", timeSec: 1, comment: "x", place: null }),
    );
    expect(h.pushes).toHaveLength(3);
    await h.bridge.handleMainEvent(event("revoked", 2, { reason: "navigation" }));
    await h.bridge.handleMainEvent(event("activated", 3, { generation: 2 }));
    await h.bridge.handleSnapshot(snapshot(1));
    expect(h.pushes).toHaveLength(4);
  });

  it("does not count a push that main refused, and shows a server refusal once as a notice", async () => {
    let accept = false;
    const refusal = Object.assign(new Error("refused"), {
      _tag: "CreatorOperationError",
      code: "limit",
      detail: "rate_limited",
    });
    const h = harness({
      push: () => accept,
      answers: { deleteComment: () => refusal },
    });
    await activate(h);
    await h.bridge.handleSnapshot(snapshot(1));
    expect(h.pushes).toHaveLength(0);
    accept = true;
    await h.bridge.handleSnapshot(snapshot(1));
    expect(h.pushes).toHaveLength(1);
    await h.bridge.handleMainEvent(guest("delete", 1, { commentId: COMMENT_A }));
    expect(h.pushes).toHaveLength(2);
    expect(h.pushes[1]).toMatchObject({ notice: "少し間をあけてください" });
    await h.bridge.handleSnapshot(snapshot(2));
    expect(h.pushes[2]).toMatchObject({ notice: null });
  });

  it("does nothing after it is disposed", async () => {
    const h = harness();
    await activate(h);
    h.bridge.dispose();
    await h.bridge.handleMainEvent(guest("delete", 1, { commentId: COMMENT_A }));
    await h.bridge.handleSnapshot(snapshot(1));
    expect(methods(h.calls)).toEqual(["setEpoch"]);
    expect(h.pushes).toHaveLength(0);
  });
});

describe("createCreatorSettingGate", () => {
  it("revokes every session once each time the setting is seen off", () => {
    let revokes = 0;
    const observe = createCreatorSettingGate(() => {
      revokes += 1;
    });
    observe(undefined);
    expect(revokes).toBe(0);
    observe(false);
    observe(false);
    expect(revokes).toBe(1);
    observe(true);
    observe(true);
    expect(revokes).toBe(1);
    observe(false);
    expect(revokes).toBe(2);
  });
});
