import {
  CREATOR_LIMITS,
  CommandId,
  CreatorBindingId,
  CreatorProposal,
  CreatorStoreFile,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type CreatorComment,
  type CreatorPlace,
  type CreatorSendRecord,
  type CreatorShotRef,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  attachShot,
  beginSend,
  byteSizeOfStore,
  cancelProposal,
  confirmByUser,
  createDraft,
  deleteComment,
  emptyCreatorState,
  finishSend,
  markAttempt,
  noteSendReason,
  propose,
  releaseHalted,
  replaceDraft,
  requestHalt,
  resolve,
  revisionKeyOf,
  setPlace,
  updateComment,
  type StateResult,
} from "./creatorState.ts";
import { makeRateGate, type RateGate } from "./rateGate.ts";

const dest = {
  environmentId: EnvironmentId.make("e1"),
  projectId: ProjectId.make("p1"),
  threadId: ThreadId.make("t1"),
};
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const binding = CreatorBindingId.make(uuid(0xb));
const at = (ms: number) => DateTime.toDateUtc(DateTime.makeUnsafe(ms));
let seq = 0;
const ctx = (ms: number, gate: RateGate = makeRateGate(), rateKey = "proj") => ({
  now: at(ms),
  newId: () => uuid(++seq),
  gate,
  rateKey,
});
const ok = <T>(r: StateResult<T>) => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r;
};
const draft = (s = emptyCreatorState(), ms = 0) =>
  ok(createDraft(s, { timeSec: 1, projectRevision: "r1" }, ctx(ms)));
const prop = (s: ReturnType<typeof emptyCreatorState>, ids: CreatorComment["id"][], ms: number) =>
  ok(propose(s, { ids, destination: dest, bindingId: binding }, ctx(ms)));
const record = (id: string): CreatorSendRecord => ({
  commandId: CommandId.make(`creator:${id}`),
  messageId: MessageId.make(`creator:${id}`),
  text: "x",
  attachments: [],
  state: "sending",
  reason: null,
  attemptedAt: "2026-10-09T00:00:00.000Z",
  attempts: 0,
  haltRequested: false,
});
const send = (
  s: ReturnType<typeof emptyCreatorState>,
  p: { id: CreatorProposal["id"]; revisionKey: string },
  ms: number,
) => beginSend(s, { proposalId: p.id, revisionKey: p.revisionKey, record: record(p.id) }, ctx(ms));
const shotFor = (id: CreatorComment["id"], revision: number): CreatorShotRef => ({
  commentId: id,
  revision,
  sha256: "a".repeat(64),
  width: 1280,
  height: 720,
});
const isStoreFile = Schema.is(CreatorStoreFile);
const isProposal = Schema.is(CreatorProposal);
const valid = (s: unknown) => expect(isStoreFile(s)).toBe(true);

describe("creatorState", () => {
  it("rejects a second proposal for a reserved comment", () => {
    const d = draft();
    const p = prop(d.state, [d.value.id], 3_000);
    expect(
      propose(p.state, { ids: [d.value.id], destination: dest, bindingId: binding }, ctx(6_000)).ok,
    ).toBe(false);
  });

  it("editing a reserved comment voids the whole proposal (no double approval)", () => {
    let s = draft().state;
    s = ok(createDraft(s, { timeSec: 2, projectRevision: "r1" }, ctx(600))).state;
    const [a, b] = s.comments;
    const p = prop(s, [a!.id, b!.id], 3_000);
    const edited = ok(updateComment(p.state, { id: a!.id, comment: "太く" }, ctx(3_100)));
    expect(edited.state.reservations).toEqual({});
    expect(edited.state.comments.map((c) => c.status)).toEqual(["draft", "draft"]);
    expect(edited.state.proposals).toEqual([]);
    expect(edited.state.history[0]).toMatchObject({ id: p.value.id, outcome: "voided" });
    expect(send(edited.state, p.value, 3_200).ok).toBe(false);
    const p2 = prop(edited.state, [a!.id], 6_000);
    expect(send(p2.state, p2.value, 6_100).ok).toBe(true);
  });

  it("a new shot after proposing voids the approval", () => {
    const d = draft();
    const p = prop(d.state, [d.value.id], 3_000);
    const s = ok(
      attachShot(p.state, { id: d.value.id, shot: shotFor(d.value.id, 1) }, ctx(3_100)),
    ).state;
    expect(s.comments[0]!.revision).toBe(2);
    expect(send(s, p.value, 3_200).ok).toBe(false);
  });

  it("a new place marks the old shot stale until a shot for the new revision arrives", () => {
    const place = (x: number): CreatorPlace => ({
      x,
      y: 0.5,
      compositionFile: null,
      elementSelector: null,
      elementLabel: null,
    });
    const d = draft();
    expect(d.value.shotStale).toBe(false);
    // No shot yet: nothing is stale (the panel shows 「画像なし」).
    let s = ok(setPlace(d.state, { id: d.value.id, place: place(0.2) }, ctx(1_000))).state;
    expect(s.comments[0]!.shotStale).toBe(false);
    s = ok(attachShot(s, { id: d.value.id, shot: shotFor(d.value.id, 2) }, ctx(1_100))).state;
    expect(s.comments[0]!.shotStale).toBe(false);
    // Re-placed, and the matching capture never came (reload, revoke, timeout).
    s = ok(setPlace(s, { id: d.value.id, place: place(0.8) }, ctx(2_000))).state;
    expect(s.comments[0]).toMatchObject({ shotStale: true, shot: shotFor(d.value.id, 2) });
    // Text edits keep the mark; only a new shot clears it.
    s = ok(updateComment(s, { id: d.value.id, comment: "太く" }, ctx(3_000))).state;
    expect(s.comments[0]!.shotStale).toBe(true);
    const revision = s.comments[0]!.revision;
    s = ok(
      attachShot(s, { id: d.value.id, shot: shotFor(d.value.id, revision) }, ctx(3_100)),
    ).state;
    expect(s.comments[0]!.shotStale).toBe(false);
    valid(s);
  });

  it("drops a shot taken for an older revision", () => {
    const d = draft();
    const s = ok(updateComment(d.state, { id: d.value.id, comment: "a" }, ctx(600))).state;
    const result = attachShot(s, { id: d.value.id, shot: shotFor(d.value.id, 1) }, ctx(700));
    expect(result).toMatchObject({ ok: false, reason: "stale_shot" });
  });

  it("refuses edits while sending, freezes what was sent", () => {
    const d = draft();
    let s = ok(updateComment(d.state, { id: d.value.id, comment: "太く" }, ctx(600))).state;
    const p = prop(s, [d.value.id], 3_000);
    s = ok(send(p.state, p.value, 3_100)).state;
    expect(updateComment(s, { id: d.value.id, comment: "細く" }, ctx(3_200))).toMatchObject({
      ok: false,
      reason: "sending",
    });
    s = ok(finishSend(s, { proposalId: p.value.id, outcome: "accepted" }, ctx(3_300))).state;
    expect(s.comments[0]!.sentVersion!.comment).toBe("太く");
    s = ok(updateComment(s, { id: d.value.id, comment: "細く" }, ctx(4_000))).state;
    expect(s.comments[0]!.status).toBe("sent");
    expect(s.comments[0]!.revision).toBe(3);
    expect(s.comments[0]!.sentVersion!.comment).toBe("太く");
    expect(s.comments[0]!.sentVersion!.revision).toBe(2);
  });

  it("rejected send returns to draft; cancel releases; resolve needs sent", () => {
    const d = draft();
    expect(resolve(d.state, { ids: [d.value.id], note: "x" }, ctx(500)).ok).toBe(false);
    const p = prop(d.state, [d.value.id], 3_000);
    const c = ok(cancelProposal(p.state, { proposalId: p.value.id }, ctx(3_100)));
    expect(c.state.reservations).toEqual({});
    expect(c.state.history[0]).toMatchObject({ id: p.value.id, outcome: "cancelled" });
    const p2 = prop(c.state, [d.value.id], 6_000);
    const s = ok(send(p2.state, p2.value, 6_100)).state;
    expect(cancelProposal(s, { proposalId: p2.value.id }, ctx(6_200)).ok).toBe(false);
    const r = ok(
      finishSend(s, { proposalId: p2.value.id, outcome: "rejected", reason: "busy" }, ctx(6_300)),
    );
    expect(r.state.comments[0]!.status).toBe("draft");
    expect(r.state.reservations).toEqual({});
    expect(r.state.history[0]).toMatchObject({ outcome: "rejected", reason: "busy" });
  });

  it("enforces rate, count and length limits with an injected gate", () => {
    const gate = makeRateGate();
    let s = emptyCreatorState();
    s = ok(createDraft(s, { timeSec: 1, projectRevision: "r1" }, ctx(0, gate))).state;
    s = ok(createDraft(s, { timeSec: 2, projectRevision: "r1" }, ctx(10, gate))).state;
    expect(createDraft(s, { timeSec: 3, projectRevision: "r1" }, ctx(20, gate)).ok).toBe(false);
    expect(createDraft(s, { timeSec: 3, projectRevision: "r1" }, ctx(20, gate, "other")).ok).toBe(
      true,
    );
    expect(
      updateComment(s, { id: s.comments[0]!.id, comment: "あ".repeat(2_001) }, ctx(2_000)).ok,
    ).toBe(false);
    const badPlace: CreatorPlace = {
      x: 2,
      y: 0,
      compositionFile: null,
      elementSelector: null,
      elementLabel: null,
    };
    expect(setPlace(s, { id: s.comments[0]!.id, place: badPlace }, ctx(2_000)).ok).toBe(false);
  });

  it("shares one draft window across create, updateComment and setPlace", () => {
    const gate = makeRateGate();
    const created = ok(
      createDraft(emptyCreatorState(), { timeSec: 1, projectRevision: "r1" }, ctx(0, gate)),
    );
    const id = created.value.id;
    const second = ok(updateComment(created.state, { id, comment: "a" }, ctx(100, gate)));
    expect(updateComment(second.state, { id, comment: "b" }, ctx(200, gate))).toMatchObject({
      ok: false,
      reason: "rate_limited",
    });
    const place: CreatorPlace = {
      x: 0.5,
      y: 0.5,
      compositionFile: null,
      elementSelector: null,
      elementLabel: null,
    };
    expect(setPlace(second.state, { id, place }, ctx(300, gate))).toMatchObject({
      ok: false,
      reason: "rate_limited",
    });
    // A refused call used no slot: the window frees at 1,000 ms (the create at 0), then one slot is left.
    expect(setPlace(second.state, { id, place }, ctx(1_000, gate)).ok).toBe(true);
    // Refusals by validation, not_found or sending do not consume a slot either.
    const fresh = makeRateGate();
    expect(updateComment(second.state, { id, comment: "あ".repeat(2_001) }, ctx(0, fresh)).ok).toBe(
      false,
    );
    expect(
      updateComment(
        second.state,
        { id: created.value.id.replace(/.$/, "f") as typeof id, comment: "x" },
        ctx(0, fresh),
      ).ok,
    ).toBe(false);
    expect(fresh.allow("proj", "draft", 0)).toBe(true);
    expect(fresh.allow("proj", "draft", 0)).toBe(true);
    expect(fresh.allow("proj", "draft", 0)).toBe(false);
  });

  it("replaces a draft's text, place and position in one gated edit", () => {
    const gate = makeRateGate();
    const created = ok(
      createDraft(emptyCreatorState(), { timeSec: 1, projectRevision: "r1" }, ctx(0, gate)),
    );
    const id = created.value.id;
    const place: CreatorPlace = {
      x: 0.1,
      y: 0.2,
      compositionFile: null,
      elementSelector: null,
      elementLabel: null,
    };
    const replaced = ok(
      replaceDraft(
        created.state,
        { id, timeSec: 4, projectRevision: "r2", comment: "new", place },
        ctx(10, gate),
      ),
    );
    expect(replaced.value).toMatchObject({
      timeSec: 4,
      projectRevision: "r2",
      comment: "new",
      place,
      revision: 2,
    });
    expect(replaced.state.revision).toBe(created.state.revision + 1);
    expect(
      replaceDraft(
        replaced.state,
        { id, timeSec: 5, projectRevision: "r2", comment: "x", place: null },
        ctx(20, gate),
      ),
    ).toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("refuses the 201st comment", () => {
    let s = emptyCreatorState();
    for (let i = 0; i < CREATOR_LIMITS.maxComments; i += 1) {
      s = ok(createDraft(s, { timeSec: i, projectRevision: "r1" }, ctx(i))).state;
    }
    expect(createDraft(s, { timeSec: 0, projectRevision: "r1" }, ctx(9_999))).toMatchObject({
      ok: false,
      reason: "limit",
    });
  });

  it("does not mutate the input state", () => {
    const d = draft();
    const before = JSON.stringify(d.state);
    ok(updateComment(d.state, { id: d.value.id, comment: "z" }, ctx(600)));
    prop(d.state, [d.value.id], 3_000);
    expect(JSON.stringify(d.state)).toBe(before);
  });

  it("refuses duplicate ids, too many ids and sending comments in propose", () => {
    const d = draft();
    expect(
      propose(
        d.state,
        { ids: [d.value.id, d.value.id], destination: dest, bindingId: binding },
        ctx(3_000),
      ),
    ).toMatchObject({ ok: false, reason: "duplicate" });
    expect(
      propose(d.state, { ids: [], destination: dest, bindingId: binding }, ctx(3_000)).ok,
    ).toBe(false);
    const p = prop(d.state, [d.value.id], 3_000);
    const s = ok(send(p.state, p.value, 3_100)).state;
    expect(
      propose(s, { ids: [d.value.id], destination: dest, bindingId: binding }, ctx(9_000)),
    ).toMatchObject({ ok: false, reason: "sending" });
  });

  it("records the binding and destination and pins content in the proposal", () => {
    const d = draft();
    const s = ok(updateComment(d.state, { id: d.value.id, comment: "太く" }, ctx(600))).state;
    const p = prop(s, [d.value.id], 3_000);
    expect(p.value.bindingId).toBe(binding);
    expect(p.value.destination).toEqual(dest);
    expect(p.value.items[0]).toMatchObject({ commentId: d.value.id, revision: 2, comment: "太く" });
    expect(p.value.revisionKey).toBe(`${d.value.id}:2`);
    expect(p.state.comments[0]!.status).toBe("proposed");
    valid(p.state);
  });

  it("keeps revisionKey within the contract limit for large proposals", () => {
    let s = emptyCreatorState();
    for (let i = 0; i < 12; i += 1) {
      s = ok(createDraft(s, { timeSec: i, projectRevision: "r1" }, ctx(i))).state;
    }
    const p = prop(
      s,
      s.comments.map((c) => c.id),
      3_000,
    );
    expect(p.value.revisionKey.length).toBeLessThanOrEqual(CREATOR_LIMITS.maxField);
    expect(p.value.revisionKey).toBe(revisionKeyOf(p.value.items));
    expect(isProposal(p.value)).toBe(true);
    const other = revisionKeyOf(
      p.value.items.map((item, i) => (i === 0 ? { ...item, revision: 9 } : item)),
    );
    expect(other).not.toBe(p.value.revisionKey);
  });

  it("beginSend with a wrong revisionKey voids the proposal and refuses", () => {
    const d = draft();
    const p = prop(d.state, [d.value.id], 3_000);
    const r = beginSend(
      p.state,
      { proposalId: p.value.id, revisionKey: "nope", record: record(p.value.id) },
      ctx(3_100),
    );
    expect(r).toMatchObject({ ok: false, reason: "stale_proposal" });
    if (r.ok || r.state === undefined) throw new Error("expected a voided state");
    expect(r.state.proposals).toEqual([]);
    expect(r.state.reservations).toEqual({});
    expect(r.state.comments[0]!.status).toBe("draft");
    expect(r.state.history[0]).toMatchObject({ outcome: "voided" });
  });

  it("accepted compacts the proposal into history and releases reservations", () => {
    const d = draft();
    const p = prop(d.state, [d.value.id], 3_000);
    const s = ok(send(p.state, p.value, 3_100)).state;
    expect(s.comments[0]!.status).toBe("sending");
    const done = ok(finishSend(s, { proposalId: p.value.id, outcome: "accepted" }, ctx(3_300)));
    expect(done.state.proposals).toEqual([]);
    expect(done.state.reservations).toEqual({});
    expect(done.state.history).toEqual([
      {
        id: p.value.id,
        bindingId: binding,
        commandId: `creator:${p.value.id}`,
        messageId: `creator:${p.value.id}`,
        outcome: "accepted",
        reason: null,
        finishedAt: at(3_300).toISOString(),
      },
    ]);
    expect(done.state.comments[0]).toMatchObject({
      status: "sent",
      sentMessageId: `creator:${p.value.id}`,
      sentAt: at(3_300).toISOString(),
    });
    valid(done.state);
  });

  it("conflict keeps comments sending and the reservation; no auto resend", () => {
    const d = draft();
    const p = prop(d.state, [d.value.id], 3_000);
    const s = ok(send(p.state, p.value, 3_100)).state;
    const c = ok(
      finishSend(
        s,
        { proposalId: p.value.id, outcome: "conflict", reason: "mismatch" },
        ctx(3_200),
      ),
    );
    expect(c.state.comments[0]!.status).toBe("sending");
    expect(c.state.reservations).toEqual({ [d.value.id]: p.value.id });
    expect(c.state.proposals[0]!.send).toMatchObject({ state: "conflict", reason: "mismatch" });
    expect(c.state.history).toEqual([]);
    expect(markAttempt(c.state, { proposalId: p.value.id })).toMatchObject({
      ok: false,
      reason: "not_sending",
    });
    expect(updateComment(c.state, { id: d.value.id, comment: "q" }, ctx(3_300)).ok).toBe(false);
    valid(c.state);
  });

  it("markAttempt counts resends and becomes stuck at 3", () => {
    const d = draft();
    const p = prop(d.state, [d.value.id], 3_000);
    let s = ok(send(p.state, p.value, 3_100)).state;
    expect(markAttempt(emptyCreatorState(), { proposalId: p.value.id }).ok).toBe(false);
    s = ok(markAttempt(s, { proposalId: p.value.id })).state;
    s = ok(markAttempt(s, { proposalId: p.value.id })).state;
    expect(s.proposals[0]!.send).toMatchObject({ attempts: 2, state: "sending" });
    s = ok(markAttempt(s, { proposalId: p.value.id })).state;
    expect(s.proposals[0]!.send).toMatchObject({ attempts: 3, state: "stuck" });
    expect(markAttempt(s, { proposalId: p.value.id }).ok).toBe(false);
    expect(s.reservations[d.value.id]).toBe(p.value.id);
  });

  it("requestHalt keeps the reservation; a late acceptance still wins", () => {
    const d = draft();
    const p = prop(d.state, [d.value.id], 3_000);
    let s = ok(send(p.state, p.value, 3_100)).state;
    s = ok(requestHalt(s, { proposalId: p.value.id })).state;
    expect(s.proposals[0]!.send).toMatchObject({ state: "halted", haltRequested: true });
    expect(s.reservations[d.value.id]).toBe(p.value.id);
    expect(s.comments[0]!.status).toBe("sending");
    expect(markAttempt(s, { proposalId: p.value.id }).ok).toBe(false);
    expect(ok(requestHalt(s, { proposalId: p.value.id })).state.proposals[0]!.send!.state).toBe(
      "halted",
    );
    s = ok(finishSend(s, { proposalId: p.value.id, outcome: "accepted" }, ctx(3_400))).state;
    expect(s.comments[0]!.status).toBe("sent");
  });

  it("markAttempt stamps the attempt time when given a clock", () => {
    const d = draft();
    const p = prop(d.state, [d.value.id], 3_000);
    const sending = ok(send(p.state, p.value, 3_100)).state;
    const counted = ok(markAttempt(sending, { proposalId: p.value.id }, ctx(40_000)));
    expect(counted.state.proposals[0]!.send).toMatchObject({
      attempts: 1,
      attemptedAt: at(40_000).toISOString(),
    });
  });

  it("noteSendReason changes only the reason of a started send", () => {
    const d = draft();
    const p = prop(d.state, [d.value.id], 3_000);
    expect(noteSendReason(p.state, { proposalId: p.value.id, reason: "x" })).toMatchObject({
      ok: false,
      reason: "not_sending",
    });
    const halted = ok(
      requestHalt(ok(send(p.state, p.value, 3_100)).state, { proposalId: p.value.id }),
    ).state;
    const noted = ok(noteSendReason(halted, { proposalId: p.value.id, reason: "unverified" }));
    expect(noted.state.proposals[0]!.send).toMatchObject({
      state: "halted",
      reason: "unverified",
      haltRequested: true,
    });
    expect(noted.state.revision).toBe(halted.revision + 1);
  });

  it("releaseHalted only works from halted or stuck", () => {
    const d = draft();
    const p = prop(d.state, [d.value.id], 3_000);
    const sending = ok(send(p.state, p.value, 3_100)).state;
    expect(releaseHalted(sending, { proposalId: p.value.id }, ctx(3_200))).toMatchObject({
      ok: false,
      reason: "not_halted",
    });
    expect(releaseHalted(p.state, { proposalId: p.value.id }, ctx(3_200))).toMatchObject({
      ok: false,
      reason: "not_sending",
    });
    const halted = ok(requestHalt(sending, { proposalId: p.value.id })).state;
    const released = ok(releaseHalted(halted, { proposalId: p.value.id }, ctx(3_300)));
    expect(released.state.comments[0]!.status).toBe("draft");
    expect(released.state.reservations).toEqual({});
    expect(released.state.proposals).toEqual([]);
    expect(released.state.history[0]).toMatchObject({ outcome: "rejected", reason: "halted" });
    let stuck = sending;
    for (let i = 0; i < 3; i += 1) stuck = ok(markAttempt(stuck, { proposalId: p.value.id })).state;
    expect(releaseHalted(stuck, { proposalId: p.value.id }, ctx(3_300)).ok).toBe(true);
  });

  it("deleting a reserved comment voids its proposal; sending refuses; sent can be deleted", () => {
    let s = draft().state;
    s = ok(createDraft(s, { timeSec: 2, projectRevision: "r1" }, ctx(600))).state;
    const [a, b] = s.comments;
    const p = prop(s, [a!.id, b!.id], 3_000);
    const del = ok(deleteComment(p.state, { id: a!.id }, ctx(3_100)));
    expect(del.value.voidedProposalId).toBe(p.value.id);
    expect(del.state.comments.map((c) => c.id)).toEqual([b!.id]);
    expect(del.state.comments[0]!.status).toBe("draft");
    expect(del.state.reservations).toEqual({});
    expect(del.state.history[0]).toMatchObject({ outcome: "voided" });
    const p2 = prop(del.state, [b!.id], 6_000);
    const sending = ok(send(p2.state, p2.value, 6_100)).state;
    expect(deleteComment(sending, { id: b!.id }, ctx(6_200))).toMatchObject({
      ok: false,
      reason: "sending",
    });
    const sent = ok(
      finishSend(sending, { proposalId: p2.value.id, outcome: "accepted" }, ctx(6_300)),
    ).state;
    const gone = ok(deleteComment(sent, { id: b!.id }, ctx(6_400)));
    expect(gone.state.comments).toEqual([]);
    expect(deleteComment(gone.state, { id: b!.id }, ctx(6_500))).toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("resolve then confirmByUser walk sent -> resolved -> confirmed", () => {
    const d = draft();
    const p = prop(d.state, [d.value.id], 3_000);
    let s = ok(send(p.state, p.value, 3_100)).state;
    s = ok(finishSend(s, { proposalId: p.value.id, outcome: "accepted" }, ctx(3_200))).state;
    expect(confirmByUser(s, { ids: [d.value.id] }).ok).toBe(false);
    s = ok(resolve(s, { ids: [d.value.id], note: "直しました" }, ctx(4_000))).state;
    expect(s.comments[0]).toMatchObject({ status: "resolved", resolvedNote: "直しました" });
    s = ok(confirmByUser(s, { ids: [d.value.id] })).state;
    expect(s.comments[0]!.status).toBe("confirmed");
  });

  it("trims history to the newest 200", () => {
    const d = draft();
    let s = d.state;
    const ids: string[] = [];
    for (let i = 0; i < CREATOR_LIMITS.maxHistory + 5; i += 1) {
      const p = prop(s, [d.value.id], i * 3_000);
      ids.push(p.value.id);
      s = ok(cancelProposal(p.state, { proposalId: p.value.id }, ctx(i * 3_000 + 1))).state;
    }
    expect(s.history).toHaveLength(CREATOR_LIMITS.maxHistory);
    expect(s.history[0]!.id).toBe(ids.at(-1));
    expect(s.history.at(-1)!.id).toBe(ids[5]);
  });

  it("stays small and usable after 300 propose/edit cycles", () => {
    const d = draft();
    let s = d.state;
    for (let i = 0; i < 300; i += 1) {
      const p = prop(s, [d.value.id], i * 3_000);
      s = ok(
        updateComment(p.state, { id: d.value.id, comment: `v${i}` }, ctx(i * 3_000 + 1)),
      ).state;
    }
    expect(s.history).toHaveLength(CREATOR_LIMITS.maxHistory);
    expect(s.proposals).toEqual([]);
    expect(s.reservations).toEqual({});
    expect(byteSizeOfStore(s)).toBeLessThan(120_000);
    valid(s);
    const p = prop(s, [d.value.id], 1_000_000);
    const sending = ok(send(p.state, p.value, 1_000_100)).state;
    const done = ok(
      finishSend(sending, { proposalId: p.value.id, outcome: "accepted" }, ctx(1_000_200)),
    );
    expect(done.state.comments[0]!.status).toBe("sent");
    expect(done.state.history).toHaveLength(CREATOR_LIMITS.maxHistory);
    expect(byteSizeOfStore(done.state)).toBeLessThan(120_000);
  });

  it("200 comments of 2,000 chars plus 200 history entries serialize under 4MB", () => {
    let s = emptyCreatorState();
    const text = "あ".repeat(CREATOR_LIMITS.maxComment);
    for (let i = 0; i < CREATOR_LIMITS.maxComments; i += 1) {
      const c = ok(
        createDraft(s, { timeSec: i, projectRevision: "r1", comment: text }, ctx(i)),
      ).state;
      s = c;
    }
    // 200 finished proposals in history (cancel cycles on the first comment).
    const first = s.comments[0]!.id;
    for (let i = 0; i < CREATOR_LIMITS.maxHistory; i += 1) {
      const p = prop(s, [first], i * 3_000);
      s = ok(cancelProposal(p.state, { proposalId: p.value.id }, ctx(i * 3_000 + 1))).state;
    }
    // Send every comment so each one also carries a `sentVersion` copy of its text.
    const ids = s.comments.map((c) => c.id);
    for (let from = 0; from < ids.length; from += CREATOR_LIMITS.maxProposalItems) {
      const p = prop(
        s,
        ids.slice(from, from + CREATOR_LIMITS.maxProposalItems),
        10_000_000 + from * 3_000,
      );
      s = ok(send(p.state, p.value, 10_000_000 + from * 3_000 + 1)).state;
      s = ok(
        finishSend(
          s,
          { proposalId: p.value.id, outcome: "accepted" },
          ctx(10_000_000 + from * 3_000 + 2),
        ),
      ).state;
    }
    expect(s.comments.every((c) => c.status === "sent")).toBe(true);
    expect(s.history).toHaveLength(CREATOR_LIMITS.maxHistory);
    expect(byteSizeOfStore(s)).toBeLessThan(CREATOR_LIMITS.maxStoreBytes);
    expect(byteSizeOfStore(s)).toBeGreaterThan(2_000_000);
    valid(s);
  });
});
