import type { CreatorComment, CreatorProposal, CreatorSendRecord } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  bindPlaceholders,
  commentActions,
  commentStatusLabel,
  formatTime,
  placeMessages,
  readPanelState,
  reconcileEdit,
  sendableIds,
} from "./panelState.ts";

const comment = (overrides: Partial<Record<keyof CreatorComment, unknown>> = {}) =>
  ({
    id: "c1",
    number: 1,
    timeSec: 76,
    place: null,
    comment: "文字を大きく",
    revision: 1,
    status: "draft",
    shot: null,
    projectRevision: "v1",
    createdAt: "2026-10-10T00:00:00.000Z",
    sentAt: null,
    sentMessageId: null,
    sentVersion: null,
    resolvedNote: null,
    ...overrides,
  }) as CreatorComment;

const sendRecord = (overrides: Partial<CreatorSendRecord> = {}) =>
  ({
    commandId: "cmd",
    messageId: "msg",
    text: "",
    attachments: [],
    state: "sending",
    reason: null,
    attemptedAt: "2026-10-10T00:00:00.000Z",
    attempts: 0,
    haltRequested: false,
    ...overrides,
  }) as CreatorSendRecord;

const proposal = (commentIds: string[], send: CreatorSendRecord | null = null) =>
  ({
    id: "p1",
    bindingId: "b1",
    destination: { environmentId: "e", projectId: "p", threadId: "t" },
    items: commentIds.map((commentId, index) => ({
      commentId,
      revision: 1,
      number: index + 1,
      timeSec: 0,
      comment: "x",
      place: null,
      shot: null,
    })),
    revisionKey: "k",
    createdAt: "2026-10-10T00:00:00.000Z",
    send,
  }) as unknown as CreatorProposal;

describe("formatTime", () => {
  it("shows minutes and seconds like the time chips", () => {
    expect(formatTime(76.4)).toBe("1分16秒");
    expect(formatTime(9.9)).toBe("9秒");
    expect(formatTime(600)).toBe("10分00秒");
    expect(formatTime(Number.NaN)).toBe("0秒");
  });
});

describe("commentStatusLabel", () => {
  const label = (
    c: CreatorComment,
    proposals: CreatorProposal[] = [],
    current: string | null = null,
  ) => commentStatusLabel(c, proposals, current);

  it("names the plain statuses", () => {
    expect(label(comment())).toBe("未送信");
    expect(label(comment({ status: "proposed" }))).toBe("確認待ち");
    expect(label(comment({ status: "sent" }))).toBe("送信済み");
    expect(label(comment({ status: "resolved" }))).toBe("対応済み");
    expect(label(comment({ status: "confirmed" }))).toBe("確認済み");
  });

  it("asks for a resend when a sent comment was edited", () => {
    const sentVersion = { comment: "前", place: null, shot: null, revision: 1 };
    expect(label(comment({ status: "sent", revision: 2, sentVersion }))).toBe("再送が必要");
    expect(label(comment({ status: "sent", revision: 1, sentVersion }))).toBe("送信済み");
  });

  it("reads the send record of a sending comment", () => {
    const sending = comment({ status: "sending" });
    expect(label(sending)).toBe("送信中");
    expect(label(sending, [proposal(["c1"], sendRecord())])).toBe("送信中");
    expect(label(sending, [proposal(["c1"], sendRecord({ attempts: 1 }))])).toBe("送信を確認中");
    for (const state of ["conflict", "stuck", "halted"] as const) {
      expect(label(sending, [proposal(["c1"], sendRecord({ state }))])).toBe("送信の確認が必要");
    }
  });

  it("adds the old-version mark when the project changed since the comment", () => {
    expect(label(comment(), [], "v2")).toBe("未送信・古い版");
    expect(label(comment(), [], "v1")).toBe("未送信");
  });
});

describe("commentActions", () => {
  it("offers send and delete for a draft", () => {
    expect(commentActions(comment(), [])).toEqual({
      sendOne: true,
      remove: true,
      cancelProposalId: null,
      confirm: false,
    });
  });

  it("offers cancel for a proposed comment with a pending proposal", () => {
    expect(commentActions(comment({ status: "proposed" }), [proposal(["c1"])])).toEqual({
      sendOne: false,
      remove: true,
      cancelProposalId: "p1",
      confirm: false,
    });
  });

  it("offers nothing while sending", () => {
    expect(
      commentActions(comment({ status: "sending" }), [proposal(["c1"], sendRecord())]),
    ).toEqual({ sendOne: false, remove: false, cancelProposalId: null, confirm: false });
  });

  it("offers confirm for a resolved comment and resend after an edit", () => {
    expect(commentActions(comment({ status: "resolved" }), []).confirm).toBe(true);
    const sentVersion = { comment: "前", place: null, shot: null, revision: 1 };
    expect(commentActions(comment({ status: "sent", revision: 2, sentVersion }), []).sendOne).toBe(
      true,
    );
    expect(commentActions(comment({ status: "sent", sentVersion }), []).sendOne).toBe(false);
  });
});

describe("sendableIds", () => {
  it("lists drafts and edited sent comments, oldest first, at most 30", () => {
    const sentVersion = { comment: "前", place: null, shot: null, revision: 1 };
    const comments = [
      comment({ id: "c3", number: 3 }),
      comment({ id: "c1", number: 1 }),
      comment({ id: "c2", number: 2, status: "proposed" }),
      comment({ id: "c4", number: 4, status: "sent", revision: 2, sentVersion }),
      comment({ id: "c5", number: 5, status: "sent", sentVersion }),
    ];
    expect(sendableIds(comments)).toEqual(["c1", "c3", "c4"]);
    const many = Array.from({ length: 40 }, (_, index) =>
      comment({ id: `c${index}`, number: index + 1 }),
    );
    expect(sendableIds(many)).toHaveLength(30);
  });
});

describe("readPanelState", () => {
  it("reads the pushed state and its optional fields", () => {
    const state = readPanelState({
      comments: [comment()],
      proposals: [proposal(["c1"])],
      projectRevision: "v2",
      draftKeys: { r1: "c1", bad: 3 },
      notice: "送信できませんでした",
    });
    expect(state?.comments).toHaveLength(1);
    expect(state?.proposals).toHaveLength(1);
    expect(state?.projectRevision).toBe("v2");
    expect(state?.draftKeys).toEqual({ r1: "c1" });
    expect(state?.notice).toBe("送信できませんでした");
  });

  it("refuses something that is not a state and skips malformed comments", () => {
    expect(readPanelState(null)).toBeNull();
    expect(readPanelState({ comments: "x" })).toBeNull();
    const state = readPanelState({ comments: [comment(), { id: 3 }], proposals: [] });
    expect(state?.comments.map((entry) => entry.id)).toEqual(["c1"]);
    expect(state?.projectRevision).toBeNull();
    expect(state?.draftKeys).toEqual({});
  });
});

describe("bindPlaceholders", () => {
  it("binds by the draft key the renderer reports", () => {
    expect(
      bindPlaceholders([{ requestId: "r1", timeSec: 5, sentText: "a" }], new Set(), {
        comments: [comment({ id: "c9", timeSec: 7 })],
        draftKeys: { r1: "c9" },
      }),
    ).toEqual(new Map([["r1", "c9"]]));
  });

  it("falls back to a new comment with the same time and text", () => {
    const comments = [
      comment({ id: "old", timeSec: 5, comment: "a" }),
      comment({ id: "new", timeSec: 5, comment: "a" }),
    ];
    expect(
      bindPlaceholders([{ requestId: "r1", timeSec: 5, sentText: "a" }], new Set(["old"]), {
        comments,
        draftKeys: {},
      }),
    ).toEqual(new Map([["r1", "new"]]));
  });

  it("does not bind a placeholder whose draft was not sent, or bind one comment twice", () => {
    const comments = [comment({ id: "new", timeSec: 5, comment: "a" })];
    expect(
      bindPlaceholders(
        [
          { requestId: "r0", timeSec: 5, sentText: null },
          { requestId: "r1", timeSec: 5, sentText: "a" },
          { requestId: "r2", timeSec: 5, sentText: "a" },
        ],
        new Set(),
        { comments, draftKeys: {} },
      ),
    ).toEqual(new Map([["r1", "new"]]));
  });
});

describe("reconcileEdit", () => {
  it("clears the local edit once the server shows that exact text", () => {
    expect(
      reconcileEdit({
        local: " 文字を大きく ",
        serverText: "文字を大きく",
        serverRevision: 3,
        sentAgainst: 2,
      }),
    ).toBe("clear");
  });

  it("waits while the update is in flight against the current revision", () => {
    expect(
      reconcileEdit({ local: "新しい", serverText: "古い", serverRevision: 2, sentAgainst: 2 }),
    ).toBe("wait");
  });

  it("re-sends when a newer revision arrives without the user's text", () => {
    // attachShot, setPlace or the AI's resolve got in first and the update was refused.
    expect(
      reconcileEdit({ local: "新しい", serverText: "古い", serverRevision: 3, sentAgainst: 2 }),
    ).toBe("resend");
  });

  it("re-sends an edit that is not in flight", () => {
    expect(
      reconcileEdit({ local: "新しい", serverText: "古い", serverRevision: 3, sentAgainst: null }),
    ).toBe("resend");
  });

  it("keeps an emptied textarea without sending it", () => {
    expect(
      reconcileEdit({ local: "  ", serverText: "古い", serverRevision: 3, sentAgainst: null }),
    ).toBe("wait");
  });
});

describe("readPanelState nested fields", () => {
  it("skips comments with malformed place, shot, sent version or note", () => {
    const state = readPanelState({
      comments: [
        comment({
          id: "ok",
          place: {
            x: 0.5,
            y: 0.5,
            compositionFile: null,
            elementSelector: "#a",
            elementLabel: null,
          },
        }),
        comment({
          id: "bad-place",
          place: { x: 2, y: 0.5, compositionFile: null, elementSelector: null, elementLabel: null },
        }),
        comment({
          id: "bad-label",
          place: { x: 0.5, y: 0.5, compositionFile: 3, elementSelector: null, elementLabel: null },
        }),
        comment({ id: "bad-sent", sentVersion: { revision: "1" } }),
        comment({ id: "bad-shot", shot: "x.png" }),
        comment({ id: "bad-note", resolvedNote: 5 }),
        comment({ id: "bad-revision", projectRevision: null }),
      ],
      proposals: [],
    });
    expect(state?.comments.map((entry) => entry.id)).toEqual(["ok"]);
  });

  it("skips proposals with malformed items or send records", () => {
    const good = proposal(["c1"], sendRecord());
    const state = readPanelState({
      comments: [],
      proposals: [
        good,
        { ...good, id: "bad-items", items: [{ commentId: 1 }] },
        { ...good, id: "bad-send", send: { state: "lost", attempts: 0 } },
        { ...good, id: "bad-attempts", send: { ...sendRecord(), attempts: "2" } },
      ],
    });
    expect(state?.proposals.map((entry) => entry.id)).toEqual(["p1"]);
  });
});

describe("placeMessages", () => {
  it("carries one request id in the place and its capture, so the renderer pairs them", () => {
    const place = {
      x: 0.7,
      y: 0.6,
      compositionFile: null,
      elementSelector: null,
      elementLabel: null,
    };
    const messages = placeMessages({
      requestId: "req-1",
      comment: { id: "c1", revision: 3, timeSec: 76 },
      place,
      pin: { x: 0.7, y: 0.6 },
    });
    expect(messages.place).toEqual({
      requestId: "req-1",
      commentId: "c1",
      expectedRevision: 3,
      place,
    });
    expect(messages.capture).toEqual({
      requestId: "req-1",
      purpose: "place",
      timeSec: 76,
      commentId: "c1",
      place,
      pin: { x: 0.7, y: 0.6 },
    });
  });
});
