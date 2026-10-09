import { describe, expect, it } from "vite-plus/test";

import { createSpikeState } from "./creatorSpikeState.ts";

const draft = (over: Record<string, unknown> = {}) => ({
  timeSec: 85.4,
  x: 0.7,
  y: 0.62,
  compositionFile: "compositions/sc05-shinbashira.html",
  elementSelector: "#sc05-w-steel",
  comment: "波の線をもう少し太く",
  ...over,
});

describe("creator spike state", () => {
  it("issues ids and numbers in main, not from the guest", () => {
    let t = 0;
    const s = createSpikeState(() => (t += 1000));
    const gen = s.activate();
    const a = s.acceptDraft(gen, { ...draft(), id: "evil", status: "sent" });
    expect(a.ok && a.value.number).toBe(1);
    expect(a.ok && a.value.status).toBe("draft");
    expect(a.ok && a.value.id).not.toBe("evil");
  });

  it("rejects requests from an old generation after navigation starts", () => {
    let t = 0;
    const s = createSpikeState(() => (t += 1000));
    const gen = s.activate();
    s.navigationStarted();
    expect(s.acceptDraft(gen, draft()).ok).toBe(false);
  });

  it("rejects out-of-range time, coordinates and oversized text", () => {
    let t = 0;
    const s = createSpikeState(() => (t += 1000));
    const gen = s.activate();
    expect(s.acceptDraft(gen, draft({ x: 1.5 })).ok).toBe(false);
    expect(s.acceptDraft(gen, draft({ timeSec: Number.POSITIVE_INFINITY })).ok).toBe(false);
    expect(s.acceptDraft(gen, draft({ comment: "あ".repeat(2001) })).ok).toBe(false);
    expect(s.acceptDraft(gen, draft({ elementSelector: "x".repeat(201) })).ok).toBe(false);
  });

  it("rate-limits drafts to two per second", () => {
    let t = 0;
    const s = createSpikeState(() => t);
    const gen = s.activate();
    expect(s.acceptDraft(gen, draft()).ok).toBe(true);
    expect(s.acceptDraft(gen, draft()).ok).toBe(true);
    expect(s.acceptDraft(gen, draft()).ok).toBe(false);
    t = 1001;
    expect(s.acceptDraft(gen, draft()).ok).toBe(true);
  });

  it("invalidates a proposal when a pin comment changes before confirmation", () => {
    let t = 0;
    const s = createSpikeState(() => (t += 3000));
    const gen = s.activate();
    const pin = s.acceptDraft(gen, draft());
    if (!pin.ok) throw new Error("setup");
    const p = s.propose(gen, [pin.value.id]);
    if (!p.ok) throw new Error("setup");
    s.updateComment(gen, pin.value.id, "やっぱり細く");
    expect(s.confirm(p.value.id, p.value.revisionKey).ok).toBe(false);
  });

  it("confirms the frozen snapshot and marks pins sent only once", () => {
    let t = 0;
    const s = createSpikeState(() => (t += 3000));
    const gen = s.activate();
    const pin = s.acceptDraft(gen, draft());
    if (!pin.ok) throw new Error("setup");
    const p = s.propose(gen, [pin.value.id]);
    if (!p.ok) throw new Error("setup");
    const first = s.confirm(p.value.id, p.value.revisionKey);
    expect(first.ok && first.value.snapshot[0]?.comment).toBe("波の線をもう少し太く");
    expect(s.pins()[0]?.status).toBe("sent");
    expect(s.confirm(p.value.id, p.value.revisionKey).ok).toBe(false);
  });

  it("limits proposals to 30 pins and one per two seconds", () => {
    let t = 0;
    const s = createSpikeState(() => t);
    const gen = s.activate();
    const ids: string[] = [];
    for (let i = 0; i < 31; i += 1) {
      t += 600;
      const r = s.acceptDraft(gen, draft());
      if (r.ok) ids.push(r.value.id);
    }
    t += 3000;
    expect(s.propose(gen, ids).ok).toBe(false);
    expect(s.propose(gen, ids.slice(0, 2)).ok).toBe(true);
    expect(s.propose(gen, ids.slice(2, 4)).ok).toBe(false);
  });
});
