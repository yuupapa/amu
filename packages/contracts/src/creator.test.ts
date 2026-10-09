import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  CREATOR_LIMITS,
  CreatorAttachShotInput,
  CreatorBindingId,
  CreatorComment,
  CreatorCommentId,
  CreatorConfirmSendInput,
  CreatorListInput,
  CreatorSetEpochInput,
  CreatorProjectId,
  CreatorProposalId,
  CreatorSendRecord,
  CreatorStoreFile,
  CreatorTabInfo,
} from "./creator.ts";
import { PreviewSessionSnapshot } from "./preview.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const UUID = "0b9f3c2e-7d41-4c8a-9e55-1a2b3c4d5e6f";
const decode = Schema.decodeUnknownSync(CreatorComment);
const decodeStore = Schema.decodeUnknownSync(CreatorStoreFile);
const decodeSendRecord = Schema.decodeUnknownSync(CreatorSendRecord);
const decodeTabInfo = Schema.decodeUnknownSync(CreatorTabInfo);
const decodeSnapshot = Schema.decodeUnknownSync(PreviewSessionSnapshot);
const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeShot = Schema.decodeUnknownSync(CreatorAttachShotInput);
const decodeList = Schema.decodeUnknownSync(CreatorListInput);
const decodeConfirm = Schema.decodeUnknownSync(CreatorConfirmSendInput);
const decodeSetEpoch = Schema.decodeUnknownSync(CreatorSetEpochInput);
const decodeProjectId = Schema.decodeUnknownSync(CreatorProjectId);
const idDecoders = [CreatorCommentId, CreatorProposalId, CreatorBindingId].map((schema) =>
  Schema.decodeUnknownSync(schema),
);
const base = {
  id: UUID,
  number: 1,
  timeSec: 76.2,
  place: null,
  comment: "金の柱を少し太く",
  revision: 1,
  status: "draft",
  shot: null,
  projectRevision: "r1",
  createdAt: "2026-10-09T00:00:00.000Z",
  sentAt: null,
  sentMessageId: null,
  sentVersion: null,
  resolvedNote: null,
};
const place = (p: object) => ({
  x: 0.5,
  y: 0.5,
  compositionFile: null,
  elementSelector: null,
  elementLabel: null,
  ...p,
});

describe("CreatorComment", () => {
  it("accepts a time-only comment", () => {
    expect(decode(base).place).toBeNull();
  });
  it("accepts a place with a relative html composition", () => {
    expect(
      decode({ ...base, place: place({ compositionFile: "compositions/a.html" }) }).place,
    ).not.toBeNull();
  });
  it("rejects bad places and over-long text", () => {
    expect(() => decode({ ...base, place: place({ x: 1.2 }) })).toThrow();
    expect(() => decode({ ...base, place: place({ y: -0.1 }) })).toThrow();
    expect(() => decode({ ...base, place: place({ compositionFile: "../etc/passwd" }) })).toThrow();
    expect(() => decode({ ...base, place: place({ compositionFile: "/abs/x.html" }) })).toThrow();
    expect(() => decode({ ...base, place: place({ compositionFile: "a/b.txt" }) })).toThrow();
    expect(() => decode({ ...base, place: place({ elementSelector: "a".repeat(201) }) })).toThrow();
    expect(() =>
      decode({ ...base, comment: "あ".repeat(CREATOR_LIMITS.maxComment + 1) }),
    ).toThrow();
    expect(() => decode({ ...base, timeSec: Number.NaN })).toThrow();
  });
  it("accepts only the six comment statuses", () => {
    for (const status of ["draft", "proposed", "sending", "sent", "resolved", "confirmed"]) {
      expect(decode({ ...base, status }).status).toBe(status);
    }
    expect(() => decode({ ...base, status: "failed" })).toThrow();
  });
});

describe("Creator ids", () => {
  it("accepts server-issued lowercase uuids only", () => {
    for (const decodeId of idDecoders) {
      expect(decodeId(UUID)).toBe(UUID);
      expect(() => decodeId("c1")).toThrow();
      expect(() => decodeId(UUID.toUpperCase())).toThrow();
      expect(() => decodeId(`${UUID.slice(0, 35)}/`)).toThrow();
      expect(() => decodeId("../../etc/passwd-0000000000000000000")).toThrow();
    }
  });
  it("accepts a 32-char hex project id only", () => {
    expect(decodeProjectId("a".repeat(32))).toBe("a".repeat(32));
    expect(() => decodeProjectId("a".repeat(31))).toThrow();
    expect(() => decodeProjectId("A".repeat(32))).toThrow();
  });
});

describe("CreatorStoreFile", () => {
  it("decodes an empty store", () => {
    const s = decodeStore({
      version: 1,
      revision: 0,
      nextNumber: 1,
      comments: [],
      proposals: [],
      reservations: {},
    });
    expect(s.comments).toEqual([]);
    expect(s.history).toEqual([]);
  });
  it("represents compacted finished proposals", () => {
    const s = decodeStore({
      version: 1,
      revision: 3,
      nextNumber: 2,
      comments: [],
      proposals: [],
      history: [
        {
          id: UUID,
          bindingId: UUID,
          commandId: null,
          messageId: null,
          outcome: "voided",
          finishedAt: "2026-10-09T00:00:00.000Z",
        },
      ],
      reservations: { [UUID]: UUID },
    });
    expect(s.history[0]?.outcome).toBe("voided");
  });
});

describe("CreatorSendRecord", () => {
  const record = {
    commandId: "cmd-1",
    messageId: "msg-1",
    text: "hello",
    attachments: [],
    state: "sending",
    reason: null,
    attemptedAt: "2026-10-09T00:00:00.000Z",
    attempts: 0,
    haltRequested: false,
  };
  it("accepts every send state", () => {
    for (const state of ["sending", "accepted", "rejected", "conflict", "stuck", "halted"]) {
      expect(decodeSendRecord({ ...record, state }).state).toBe(state);
    }
    expect(() => decodeSendRecord({ ...record, state: "sent" })).toThrow();
  });
});

describe("integration points", () => {
  it("carries creator only on the preview snapshot", () => {
    const info = decodeTabInfo({ bindingId: UUID, label: "x" });
    const snap = decodeSnapshot({
      threadId: "t",
      tabId: "tab",
      navStatus: { _tag: "Idle" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-10-09T00:00:00.000Z",
      creator: info,
    });
    expect(snap.creator?.bindingId).toBe(UUID);
  });
  it("defaults amuCreatorEnabled to false and accepts it in a patch", () => {
    expect(decodeSettings({}).amuCreatorEnabled).toBe(false);
    expect(decodeSettingsPatch({ amuCreatorEnabled: true })).toEqual({
      amuCreatorEnabled: true,
    });
  });
});

describe("RPC contract", () => {
  const binding = { bindingId: UUID, epoch: 0 };
  it("decodes a base64 PNG and refuses an empty or oversized one", () => {
    const input = { ...binding, commentId: UUID, expectedRevision: 1 };
    expect(decodeShot({ ...input, png: "iVBORw0KGgo=" }).png.byteLength).toBe(8);
    expect(() => decodeShot({ ...input, png: "" })).toThrow();
    const big = "AAAA".repeat(Math.ceil((CREATOR_LIMITS.maxShotBytes + 1) / 3));
    expect(() => decodeShot({ ...input, png: big })).toThrow();
  });
  it("requires bindingId and a non-negative integer epoch", () => {
    expect(decodeList(binding)).toEqual(binding);
    expect(() => decodeList({ bindingId: UUID })).toThrow();
    expect(() => decodeList({ ...binding, epoch: -1 })).toThrow();
    expect(() => decodeList({ ...binding, epoch: 1.5 })).toThrow();
  });
  it("confirmSend carries epoch, proposalId and revisionKey", () => {
    expect(decodeConfirm({ ...binding, proposalId: UUID, revisionKey: "k" }).revisionKey).toBe("k");
    expect(() => decodeConfirm({ ...binding, proposalId: UUID })).toThrow();
  });
  it("setEpoch accepts a null generation", () => {
    expect(decodeSetEpoch({ ...binding, generation: null }).generation).toBeNull();
  });
  it("registers every creator method in the websocket group", () => {
    for (const method of Object.values(WS_METHODS).filter((m) => m.startsWith("creator."))) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
    }
    expect(Object.values(WS_METHODS).filter((m) => m.startsWith("creator."))).toHaveLength(15);
  });
});
