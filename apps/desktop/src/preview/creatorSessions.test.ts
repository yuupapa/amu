import { CREATOR_LIMITS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isCreatorGuestUrl, makeCreatorLedger, measureGuestPayload } from "./creatorSessions.ts";

const BINDING = "11111111-1111-4111-8111-111111111111";
const OTHER_BINDING = "22222222-2222-4222-8222-222222222222";
const WC = 42;
const ATTACHMENT = Symbol("attachment");

const setup = () => {
  const ledger = makeCreatorLedger();
  const registered = ledger.register({
    tabId: "tab",
    bindingId: BINDING,
    webContentsId: WC,
    attachmentId: ATTACHMENT,
  });
  const guest = (generation: number, payload: unknown = { comment: "x" }, now = 0) => ({
    tabId: "tab",
    webContentsId: WC,
    attachmentId: ATTACHMENT,
    message: { generation, payload },
    now,
  });
  return { ledger, registered, guest };
};

describe("creator ledger: registration and revocation", () => {
  it("activates the current document as generation 1 with an epoch of at least 1", () => {
    const { ledger, registered } = setup();
    expect(registered.activated).toMatchObject({
      tabId: "tab",
      bindingId: BINDING,
      generation: 1,
      active: true,
    });
    expect(registered.activated.epoch).toBeGreaterThanOrEqual(1);
    expect(ledger.isCurrent("tab", 1)).toBe(true);
  });

  it("revokes on a new main-frame document and bumps the epoch on revoke and reactivation", () => {
    const { ledger, registered } = setup();
    const first = registered.activated.epoch;
    const revoked = ledger.navigationStarted(WC);
    expect(revoked).toMatchObject({ tabId: "tab", bindingId: BINDING, epoch: first + 1 });
    expect(ledger.isCurrent("tab", 1)).toBe(false);
    const again = ledger.register({
      tabId: "tab",
      bindingId: BINDING,
      webContentsId: WC,
      attachmentId: ATTACHMENT,
    });
    expect(again.activated.generation).toBe(2);
    expect(again.activated.epoch).toBe(first + 2);
    expect(ledger.isCurrent("tab", 2)).toBe(true);
  });

  it("re-registering an active session bumps the epoch once and keeps the document", () => {
    const { ledger, registered } = setup();
    const again = ledger.register({
      tabId: "tab",
      bindingId: BINDING,
      webContentsId: WC,
      attachmentId: ATTACHMENT,
    });
    expect(again.revoked).toBeNull();
    expect(again.activated.generation).toBe(1);
    expect(again.activated.epoch).toBe(registered.activated.epoch + 1);
  });

  it("revokes the previous binding when another binding takes the tab", () => {
    const { ledger, registered } = setup();
    const next = ledger.register({
      tabId: "tab",
      bindingId: OTHER_BINDING,
      webContentsId: WC,
      attachmentId: ATTACHMENT,
    });
    expect(next.revoked).toMatchObject({
      bindingId: BINDING,
      epoch: registered.activated.epoch + 1,
    });
    expect(next.activated).toMatchObject({
      bindingId: OTHER_BINDING,
      epoch: registered.activated.epoch + 2,
    });
  });

  it("revokes on guest swap, tab close, destroyed and revokeAll", () => {
    for (const revoke of [
      (ledger: ReturnType<typeof makeCreatorLedger>) => ledger.revoke("tab"),
      (ledger: ReturnType<typeof makeCreatorLedger>) => ledger.closeTab("tab"),
      (ledger: ReturnType<typeof makeCreatorLedger>) => ledger.forgetWebContents(WC),
      (ledger: ReturnType<typeof makeCreatorLedger>) => ledger.revokeAll()[0] ?? null,
    ]) {
      const { ledger, registered } = setup();
      expect(revoke(ledger)).toMatchObject({
        tabId: "tab",
        bindingId: BINDING,
        epoch: registered.activated.epoch + 1,
      });
      expect(ledger.isCurrent("tab", 1)).toBe(false);
      // A second revoke has nothing left to revoke and does not bump the epoch.
      expect(ledger.revoke("tab")).toBeNull();
    }
  });

  it("keeps a tab's epoch monotonic after the tab closes", () => {
    const { ledger, registered } = setup();
    ledger.closeTab("tab");
    const reopened = ledger.register({
      tabId: "tab",
      bindingId: BINDING,
      webContentsId: 43,
      attachmentId: ATTACHMENT,
    });
    expect(reopened.activated.epoch).toBe(registered.activated.epoch + 2);
  });

  it("does not revoke a session bound to another guest", () => {
    const { ledger } = setup();
    expect(ledger.navigationStarted(99)).toBeNull();
    expect(ledger.isCurrent("tab", 1)).toBe(true);
  });
});

describe("creator ledger: approval point", () => {
  it("an approval taken before navigation stands with the epoch it returned", () => {
    const { ledger, registered } = setup();
    const approval = ledger.approve("tab", 1);
    expect(approval).toEqual({ ok: true, epoch: registered.activated.epoch });
    const revoked = ledger.navigationStarted(WC);
    expect(revoked?.epoch).toBe(registered.activated.epoch + 1);
    // The server compares epochs: the approval's epoch is older than the revoke.
    expect(approval).toEqual({ ok: true, epoch: registered.activated.epoch });
  });

  it("an approval after navigation is refused", () => {
    const { ledger } = setup();
    ledger.navigationStarted(WC);
    expect(ledger.approve("tab", 1)).toEqual({ ok: false, reason: "inactive" });
  });

  it("an approval for another document generation is refused", () => {
    const { ledger } = setup();
    expect(ledger.approve("tab", 2)).toEqual({ ok: false, reason: "stale_generation" });
    expect(ledger.approve("missing", 1)).toEqual({ ok: false, reason: "no_session" });
  });
});

describe("creator ledger: guest messages", () => {
  it("accepts a message for the current generation and hands back a JSON copy", () => {
    const { ledger, guest } = setup();
    const result = ledger.admitGuestMessage({ ...guest(1), kind: "draft" });
    expect(result).toMatchObject({ ok: true, payload: { comment: "x" } });
  });

  it("refuses revoked sessions, stale generations and other guests", () => {
    const { ledger, guest } = setup();
    expect(ledger.admitGuestMessage({ ...guest(2), kind: "draft" })).toEqual({
      ok: false,
      reason: "stale_generation",
    });
    expect(
      ledger.admitGuestMessage({ ...guest(1), attachmentId: Symbol("old"), kind: "draft" }),
    ).toEqual({ ok: false, reason: "wrong_guest" });
    expect(ledger.admitGuestMessage({ ...guest(1), webContentsId: 7, kind: "draft" })).toEqual({
      ok: false,
      reason: "wrong_guest",
    });
    ledger.navigationStarted(WC);
    expect(ledger.admitGuestMessage({ ...guest(1), kind: "draft" })).toEqual({
      ok: false,
      reason: "inactive",
    });
  });

  it("refuses a malformed message", () => {
    const { ledger } = setup();
    expect(
      ledger.admitGuestMessage({
        tabId: "tab",
        webContentsId: WC,
        attachmentId: ATTACHMENT,
        message: "nope",
        now: 0,
        kind: "draft",
      }),
    ).toEqual({ ok: false, reason: "bad_request" });
  });

  it("refuses a message over 256KB", () => {
    const { ledger, guest } = setup();
    const big = "あ".repeat(Math.ceil(CREATOR_LIMITS.maxMessageBytes / 3) + 1);
    expect(ledger.admitGuestMessage({ ...guest(1, { comment: big }), kind: "draft" })).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("shares 2 per second across draft, update, place and delete", () => {
    const { ledger, guest } = setup();
    expect(ledger.admitGuestMessage({ ...guest(1, {}, 0), kind: "draft" }).ok).toBe(true);
    expect(ledger.admitGuestMessage({ ...guest(1, {}, 100), kind: "update" }).ok).toBe(true);
    expect(ledger.admitGuestMessage({ ...guest(1, {}, 200), kind: "place" })).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    expect(ledger.admitGuestMessage({ ...guest(1, {}, 1_000), kind: "delete" }).ok).toBe(true);
  });

  it("allows one propose or cancel per 2 seconds", () => {
    const { ledger, guest } = setup();
    expect(ledger.admitGuestMessage({ ...guest(1, {}, 0), kind: "propose" }).ok).toBe(true);
    expect(ledger.admitGuestMessage({ ...guest(1, {}, 1_999), kind: "cancel" })).toEqual({
      ok: false,
      reason: "rate_limited",
    });
    expect(ledger.admitGuestMessage({ ...guest(1, {}, 2_000), kind: "cancel" }).ok).toBe(true);
  });

  it("keeps the rate gate across re-registration of the same guest", () => {
    const { ledger, guest } = setup();
    ledger.admitGuestMessage({ ...guest(1, {}, 0), kind: "draft" });
    ledger.admitGuestMessage({ ...guest(1, {}, 0), kind: "draft" });
    ledger.navigationStarted(WC);
    ledger.navigationCommitted(WC);
    ledger.register({
      tabId: "tab",
      bindingId: BINDING,
      webContentsId: WC,
      attachmentId: ATTACHMENT,
    });
    expect(ledger.admitGuestMessage({ ...guest(2, {}, 10), kind: "draft" })).toEqual({
      ok: false,
      reason: "rate_limited",
    });
  });
});

describe("creator ledger: capture requests", () => {
  const request = (generation: number, requestId: string, now = 0) => ({
    tabId: "tab",
    webContentsId: WC,
    attachmentId: ATTACHMENT,
    message: { generation, requestId, purpose: "draft", timeSec: 12.5 },
    now,
  });
  const ready = (generation: number, requestId: string, now = 0) => ({
    tabId: "tab",
    webContentsId: WC,
    attachmentId: ATTACHMENT,
    message: { generation, requestId, rect: { x: 0, y: 0, width: 10, height: 10 } },
    now,
  });

  it("runs one capture at a time and refuses a second concurrent request", () => {
    const { ledger } = setup();
    expect(ledger.beginCapture(request(1, "a"))).toMatchObject({
      ok: true,
      capture: { requestId: "a", purpose: "draft", timeSec: 12.5, generation: 1 },
    });
    expect(ledger.beginCapture(request(1, "b"))).toEqual({
      ok: false,
      reason: "capture_busy",
      requestId: "b",
    });
    expect(ledger.beginCapture(request(1, "a"))).toEqual({
      ok: false,
      reason: "duplicate_request",
      requestId: "a",
    });
  });

  it("finishes a capture whose ready and result arrive in time", () => {
    const { ledger } = setup();
    ledger.beginCapture(request(1, "a"));
    expect(ledger.captureReady(ready(1, "a", 100))).toMatchObject({
      ok: true,
      rect: { x: 0, y: 0, width: 10, height: 10 },
    });
    expect(ledger.finishCapture("tab", "a")).toMatchObject({
      ok: true,
      capture: { requestId: "a" },
    });
    // The slot is free again once capturePage settled and a second has passed.
    ledger.captureSettled(WC, "a");
    expect(ledger.beginCapture(request(1, "b", 1_000)).ok).toBe(true);
  });

  it("discards a ready that arrives after the timeout", () => {
    const { ledger } = setup();
    ledger.beginCapture(request(1, "a", 0));
    expect(ledger.expireCapture("tab", "a")).toBe(true);
    expect(ledger.captureReady(ready(1, "a", 6_000))).toEqual({ ok: false, reason: "no_capture" });
    expect(ledger.finishCapture("tab", "a")).toEqual({ ok: false, reason: "no_capture" });
  });

  it("discards a ready past its deadline even before the timer fires", () => {
    const { ledger } = setup();
    ledger.beginCapture(request(1, "a", 0));
    expect(ledger.captureReady(ready(1, "a", CREATOR_LIMITS.captureTimeoutMs + 1))).toEqual({
      ok: false,
      reason: "capture_timeout",
    });
    expect(ledger.beginCapture(request(1, "b", CREATOR_LIMITS.captureTimeoutMs + 2)).ok).toBe(true);
  });

  it("discards the result of a capture revoked while capturePage runs", () => {
    const { ledger } = setup();
    ledger.beginCapture(request(1, "a"));
    ledger.captureReady(ready(1, "a"));
    const revoked = ledger.navigationStarted(WC);
    expect(revoked?.discardedCaptureId).toBe("a");
    expect(ledger.finishCapture("tab", "a")).toEqual({ ok: false, reason: "no_capture" });
  });

  it("discards a capture when the tab is re-registered mid-capture", () => {
    const { ledger } = setup();
    ledger.beginCapture(request(1, "a"));
    ledger.captureReady(ready(1, "a"));
    const again = ledger.register({
      tabId: "tab",
      bindingId: BINDING,
      webContentsId: WC,
      attachmentId: ATTACHMENT,
    });
    expect(again.discardedCaptureId).toBe("a");
    expect(ledger.finishCapture("tab", "a")).toEqual({ ok: false, reason: "no_capture" });
  });

  it("refuses ready for another request id or generation, and requests from stale documents", () => {
    const { ledger } = setup();
    ledger.beginCapture(request(1, "a"));
    expect(ledger.captureReady(ready(1, "b"))).toEqual({ ok: false, reason: "no_capture" });
    expect(ledger.captureReady(ready(2, "a"))).toEqual({ ok: false, reason: "stale_generation" });
    expect(ledger.beginCapture(request(2, "c"))).toEqual({
      ok: false,
      reason: "stale_generation",
      requestId: "c",
    });
  });

  it("refuses malformed capture requests", () => {
    const { ledger } = setup();
    for (const message of [
      { generation: 1, requestId: "a b", purpose: "draft", timeSec: 1 },
      { generation: 1, requestId: "a", purpose: "other", timeSec: 1 },
      { generation: 1, requestId: "a", purpose: "draft", timeSec: -1 },
      { generation: 1, requestId: "a", purpose: "place", timeSec: 1, commentId: 5 },
    ]) {
      expect(
        ledger.beginCapture({
          tabId: "tab",
          webContentsId: WC,
          attachmentId: ATTACHMENT,
          message,
          now: 0,
        }).ok,
      ).toBe(false);
    }
  });
});

describe("measureGuestPayload", () => {
  it("counts UTF-8 bytes of the JSON form and returns a plain copy", () => {
    const measured = measureGuestPayload({ text: "あ" });
    expect(measured).toEqual({ json: { text: "あ" }, bytes: '{"text":"あ"}'.length + 2 });
  });

  it("refuses values that are not JSON", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(measureGuestPayload(cyclic)).toBeNull();
    expect(measureGuestPayload(undefined)).toBeNull();
  });
});

describe("measureGuestPayload limits", () => {
  it("reports an oversized value without parsing it", () => {
    const measured = measureGuestPayload({ text: "x".repeat(100) }, 50);
    expect(measured?.json).toBeNull();
    expect(measured?.bytes).toBeGreaterThan(50);
  });
});

describe("isCreatorGuestUrl", () => {
  it("accepts only the loopback HTTP origins HyperFrames Studio serves on", () => {
    expect(isCreatorGuestUrl("http://localhost:3002/#project")).toBe(true);
    expect(isCreatorGuestUrl("http://127.0.0.1:41000/")).toBe(true);
    expect(isCreatorGuestUrl("https://localhost:3002/")).toBe(false);
    expect(isCreatorGuestUrl("http://example.com/")).toBe(false);
    expect(isCreatorGuestUrl("http://localhost.example.com/")).toBe(false);
    expect(isCreatorGuestUrl("about:blank")).toBe(false);
    expect(isCreatorGuestUrl("not a url")).toBe(false);
  });
});

describe("creator ledger: current document", () => {
  it("names the live session only while the guest still shows its document", () => {
    const { ledger } = setup();
    expect(ledger.currentDocumentSession(WC)?.generation).toBe(1);
    ledger.navigationStarted(WC);
    expect(ledger.currentDocumentSession(WC)).toBeUndefined();
    ledger.navigationCommitted(WC);
    ledger.register({
      tabId: "tab",
      bindingId: BINDING,
      webContentsId: WC,
      attachmentId: ATTACHMENT,
    });
    expect(ledger.currentDocumentSession(WC)?.generation).toBe(2);
    expect(ledger.currentDocumentSession(99)).toBeUndefined();
  });
});

describe("creator ledger: capture rate and in-flight captures (fix round 1)", () => {
  const request = (requestId: string, now: number, generation = 1) => ({
    tabId: "tab",
    webContentsId: WC,
    attachmentId: ATTACHMENT,
    message: { generation, requestId, purpose: "draft", timeSec: 1 },
    now,
  });
  const ready = (requestId: string, now: number, generation = 1) => ({
    tabId: "tab",
    webContentsId: WC,
    attachmentId: ATTACHMENT,
    message: { generation, requestId, rect: { x: 0, y: 0, width: 10, height: 10 } },
    now,
  });

  it("starts at most one capture per second per guest, across re-registration", () => {
    const { ledger } = setup();
    expect(ledger.beginCapture(request("a", 0)).ok).toBe(true);
    ledger.captureReady(ready("a", 10));
    ledger.finishCapture("tab", "a");
    ledger.captureSettled(WC, "a");
    expect(ledger.beginCapture(request("b", 500))).toEqual({
      ok: false,
      reason: "rate_limited",
      requestId: "b",
    });
    ledger.navigationStarted(WC);
    ledger.navigationCommitted(WC);
    ledger.register({
      tabId: "tab",
      bindingId: BINDING,
      webContentsId: WC,
      attachmentId: ATTACHMENT,
    });
    expect(ledger.beginCapture(request("c", 900, 2))).toEqual({
      ok: false,
      reason: "rate_limited",
      requestId: "c",
    });
    expect(ledger.beginCapture(request("d", 1_000, 2)).ok).toBe(true);
  });

  it("does not start a capture while an expired one's capturePage is still running", () => {
    const { ledger } = setup();
    ledger.beginCapture(request("a", 0));
    expect(ledger.captureReady(ready("a", 10)).ok).toBe(true);
    expect(ledger.expireCapture("tab", "a")).toBe(true);
    expect(ledger.beginCapture(request("b", 6_000))).toEqual({
      ok: false,
      reason: "capture_busy",
      requestId: "b",
    });
    ledger.captureSettled(WC, "a");
    expect(ledger.beginCapture(request("c", 6_100)).ok).toBe(true);
  });

  it("names an expired request it replaces so the guest can be released", () => {
    const { ledger } = setup();
    ledger.beginCapture(request("a", 0));
    expect(ledger.beginCapture(request("b", CREATOR_LIMITS.captureTimeoutMs + 1))).toMatchObject({
      ok: true,
      replacedRequestId: "a",
    });
  });
});

describe("creator ledger: pending navigation (fix round 1)", () => {
  it("records a registration made mid-navigation but keeps the outgoing document out", () => {
    const { ledger, guest } = setup();
    ledger.navigationStarted(WC);
    const registered = ledger.register({
      tabId: "tab",
      bindingId: BINDING,
      webContentsId: WC,
      attachmentId: ATTACHMENT,
    });
    expect(registered.activated.generation).toBe(2);
    expect(registered.navigating).toBe(true);
    expect(ledger.admitGuestMessage({ ...guest(2), kind: "draft" })).toEqual({
      ok: false,
      reason: "navigating",
    });
    expect(
      ledger.beginCapture({
        tabId: "tab",
        webContentsId: WC,
        attachmentId: ATTACHMENT,
        message: { generation: 2, requestId: "a", purpose: "draft", timeSec: 1 },
        now: 0,
      }),
    ).toEqual({ ok: false, reason: "navigating", requestId: "a" });
    expect(ledger.currentDocumentSession(WC)).toBeUndefined();

    ledger.navigationCommitted(WC);
    expect(ledger.currentDocumentSession(WC)?.generation).toBe(2);
    expect(ledger.admitGuestMessage({ ...guest(2), kind: "draft" }).ok).toBe(true);
  });

  it("reports whether a navigation that ended without a commit was pending", () => {
    const { ledger } = setup();
    expect(ledger.navigationSettled(WC)).toBe(false);
    ledger.navigationStarted(WC);
    expect(ledger.navigationSettled(WC)).toBe(true);
    expect(ledger.navigationSettled(WC)).toBe(false);
  });
});

describe("creator ledger: stalled capturePage hold (fix round 2)", () => {
  const request = (requestId: string, now: number, generation = 1) => ({
    tabId: "tab",
    webContentsId: WC,
    attachmentId: ATTACHMENT,
    message: { generation, requestId, purpose: "draft", timeSec: 1 },
    now,
  });
  const ready = (requestId: string, now: number) => ({
    tabId: "tab",
    webContentsId: WC,
    attachmentId: ATTACHMENT,
    message: { generation: 1, requestId, rect: { x: 0, y: 0, width: 10, height: 10 } },
    now,
  });
  const stall = (ledger: ReturnType<typeof makeCreatorLedger>) => {
    ledger.beginCapture(request("a", 0));
    ledger.captureReady(ready("a", 10));
    ledger.expireCapture("tab", "a");
  };

  it("releases a capturePage that never settles after 3 capture timeouts", () => {
    const { ledger } = setup();
    stall(ledger);
    const hold = 3 * CREATOR_LIMITS.captureTimeoutMs;
    expect(ledger.beginCapture(request("b", 10 + hold - 1))).toMatchObject({
      ok: false,
      reason: "capture_busy",
    });
    expect(ledger.beginCapture(request("c", 10 + hold)).ok).toBe(true);
    // The stalled capture's late settle does not touch the new one.
    ledger.captureSettled(WC, "a");
    ledger.captureReady(ready("c", 10 + hold + 1));
    expect(ledger.finishCapture("tab", "a")).toEqual({ ok: false, reason: "no_capture" });
  });

  it("forgetting the guest clears the hold", () => {
    const { ledger } = setup();
    stall(ledger);
    ledger.forgetWebContents(WC);
    ledger.register({
      tabId: "tab",
      bindingId: BINDING,
      webContentsId: WC,
      attachmentId: ATTACHMENT,
    });
    expect(ledger.beginCapture(request("b", 2_000)).ok).toBe(true);
  });

  it("a committed main-frame navigation clears the hold", () => {
    const { ledger } = setup();
    stall(ledger);
    ledger.navigationStarted(WC);
    ledger.navigationCommitted(WC);
    ledger.register({
      tabId: "tab",
      bindingId: BINDING,
      webContentsId: WC,
      attachmentId: ATTACHMENT,
    });
    expect(ledger.beginCapture(request("b", 2_000, 2)).ok).toBe(true);
  });
});
