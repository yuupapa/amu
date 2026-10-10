/**
 * Amu Creator session ledger for the desktop main process. Pure and
 * synchronous: every decision happens inside one call, so a decision and a
 * navigation that both run on main's event loop are ordered without locks.
 *
 * - `generation` is the guest's main-frame document: 1 for the first document a
 *   guest shows, +1 on every cross-document main-frame navigation start.
 * - `epoch` is per tab and only ever grows: +1 on every activation and every
 *   revocation. The renderer passes it to the server, which refuses anything
 *   older than the newest epoch it has heard of.
 * - Rate gates are keyed by webContents, so re-registering the same guest does
 *   not reset them.
 *
 * Main never stores comments or proposals; it only stamps and forwards.
 */
import { CREATOR_LIMITS, type DesktopPreviewCreatorGuestKind } from "@t3tools/contracts";

export type CreatorCapturePurpose = "draft" | "place";

export type CreatorRefusal =
  | "no_session"
  | "inactive"
  | "wrong_guest"
  | "navigating"
  | "stale_generation"
  | "bad_request"
  | "too_large"
  | "rate_limited"
  | "capture_busy"
  | "duplicate_request"
  | "no_capture"
  | "capture_timeout";

export interface CreatorSession {
  readonly tabId: string;
  readonly webContentsId: number;
  /** The `attachListeners` attachment the session was registered on. */
  readonly attachmentId: unknown;
  readonly bindingId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly active: boolean;
}

export interface CreatorRevocation {
  readonly tabId: string;
  readonly bindingId: string;
  readonly webContentsId: number;
  readonly epoch: number;
  /** A capture that was waiting or running; its result must be dropped. */
  readonly discardedCaptureId: string | null;
}

export interface CreatorPendingCapture {
  readonly requestId: string;
  readonly generation: number;
  readonly epoch: number;
  readonly purpose: CreatorCapturePurpose;
  readonly timeSec: number;
  readonly commentId: string | null;
  readonly place: unknown;
  readonly deadline: number;
}

interface GuestInput {
  readonly tabId: string;
  readonly webContentsId: number;
  readonly attachmentId: unknown;
  readonly message: unknown;
  readonly now: number;
}

type Refused = { readonly ok: false; readonly reason: CreatorRefusal };

const COMMENT_KINDS: ReadonlySet<DesktopPreviewCreatorGuestKind> = new Set([
  "draft",
  "update",
  "place",
  "delete",
  "confirm-by-user",
]);
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Captures a guest may start, at most one per this many ms. */
const CAPTURE_INTERVAL_MS = 1_000;
/**
 * How long a capturePage that never settles holds its guest. Stalled captures
 * are real (a wedged compositor); after this the guest may capture again and
 * the stalled result, if it ever arrives, is dropped.
 */
const CAPTURE_HOLD_MS = 3 * CREATOR_LIMITS.captureTimeoutMs;
const MAX_TIME_SEC = 24 * 60 * 60;

const utf8 = new TextEncoder();

/**
 * Serialized size of a guest message, measured on its JSON form. Returns that
 * JSON parsed back, so what main forwards is exactly what it measured (no
 * Maps, typed arrays or other structured-clone extras), or null when the
 * value has no JSON form.
 */
export const measureGuestPayload = (
  value: unknown,
  maxBytes: number = CREATOR_LIMITS.maxMessageBytes,
): { json: unknown; bytes: number } | null => {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (text === undefined) return null;
  // UTF-8 never takes fewer bytes than UTF-16 code units, so an oversized
  // value is reported (with `json: null`) without encoding or parsing it.
  if (text.length > maxBytes) return { json: null, bytes: text.length };
  const bytes = utf8.encode(text).byteLength;
  return bytes > maxBytes ? { json: null, bytes } : { json: JSON.parse(text), bytes };
};

/** HyperFrames Studio is served on loopback HTTP; no other page may act as the Creator guest. */
export const isCreatorGuestUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const makeCreatorLedger = () => {
  const sessions = new Map<string, CreatorSession>();
  const epochs = new Map<string, number>();
  const documents = new Map<number, number>();
  const rates = new Map<
    number,
    { comment: number[]; lastProposeAt: number; lastCaptureAt: number }
  >();
  const captures = new Map<string, CreatorPendingCapture>();
  // Guests with a cross-document navigation started but not yet committed or failed.
  const navigating = new Set<number>();
  // Guests whose capturePage for this request has not settled yet, even if the
  // request itself expired or was revoked.
  const inFlight = new Map<number, { readonly requestId: string; readonly since: number }>();

  const bumpEpoch = (tabId: string): number => {
    const next = (epochs.get(tabId) ?? 0) + 1;
    epochs.set(tabId, next);
    return next;
  };
  const documentGeneration = (webContentsId: number): number => documents.get(webContentsId) ?? 1;

  const revokeActive = (session: CreatorSession): CreatorRevocation => {
    const epoch = bumpEpoch(session.tabId);
    const capture = captures.get(session.tabId);
    captures.delete(session.tabId);
    sessions.set(session.tabId, { ...session, epoch, active: false });
    return {
      tabId: session.tabId,
      bindingId: session.bindingId,
      webContentsId: session.webContentsId,
      epoch,
      discardedCaptureId: capture?.requestId ?? null,
    };
  };

  const revoke = (tabId: string): CreatorRevocation | null => {
    const session = sessions.get(tabId);
    return session?.active ? revokeActive(session) : null;
  };

  const sessionForGuest = (webContentsId: number): CreatorSession | undefined => {
    for (const session of sessions.values()) {
      if (session.active && session.webContentsId === webContentsId) return session;
    }
    return undefined;
  };

  /** Shared sender check: the live session of this tab, on this guest and attachment, for this document. */
  const admit = (
    input: GuestInput,
  ): { readonly ok: true; readonly session: CreatorSession } | Refused => {
    const session = sessions.get(input.tabId);
    if (!session) return { ok: false, reason: "no_session" };
    if (!session.active) return { ok: false, reason: "inactive" };
    if (
      session.webContentsId !== input.webContentsId ||
      session.attachmentId !== input.attachmentId
    ) {
      return { ok: false, reason: "wrong_guest" };
    }
    // The outgoing document must not speak for the session registered for the next one.
    if (navigating.has(input.webContentsId)) return { ok: false, reason: "navigating" };
    if (!isRecord(input.message)) return { ok: false, reason: "bad_request" };
    if (input.message["generation"] !== session.generation) {
      return { ok: false, reason: "stale_generation" };
    }
    return { ok: true, session };
  };

  const rateOf = (webContentsId: number) => {
    const rate = rates.get(webContentsId) ?? {
      comment: [],
      lastProposeAt: Number.NEGATIVE_INFINITY,
      lastCaptureAt: Number.NEGATIVE_INFINITY,
    };
    rates.set(webContentsId, rate);
    return rate;
  };

  const takeRate = (
    webContentsId: number,
    kind: DesktopPreviewCreatorGuestKind,
    now: number,
  ): boolean => {
    const rate = rateOf(webContentsId);
    if (COMMENT_KINDS.has(kind)) {
      rate.comment = rate.comment.filter((at) => now - at < CREATOR_LIMITS.commentRateWindowMs);
      if (rate.comment.length >= CREATOR_LIMITS.commentRateMax) return false;
      rate.comment.push(now);
      return true;
    }
    if (now - rate.lastProposeAt < CREATOR_LIMITS.proposeIntervalMs) return false;
    rate.lastProposeAt = now;
    return true;
  };

  return {
    session: (tabId: string): CreatorSession | undefined => sessions.get(tabId),

    /** Activates `bindingId` on the guest's current document. */
    register: (input: {
      readonly tabId: string;
      readonly bindingId: string;
      readonly webContentsId: number;
      readonly attachmentId: unknown;
    }) => {
      const current = sessions.get(input.tabId);
      let revoked: CreatorRevocation | null = null;
      let discardedCaptureId: string | null = null;
      if (
        current?.active &&
        (current.bindingId !== input.bindingId ||
          current.webContentsId !== input.webContentsId ||
          current.attachmentId !== input.attachmentId)
      ) {
        revoked = revokeActive(current);
        discardedCaptureId = revoked.discardedCaptureId;
      } else {
        discardedCaptureId = captures.get(input.tabId)?.requestId ?? null;
        captures.delete(input.tabId);
      }
      const activated: CreatorSession = {
        tabId: input.tabId,
        webContentsId: input.webContentsId,
        attachmentId: input.attachmentId,
        bindingId: input.bindingId,
        generation: documentGeneration(input.webContentsId),
        epoch: bumpEpoch(input.tabId),
        active: true,
      };
      sessions.set(input.tabId, activated);
      // While navigating, the activation waits for the new document (dom-ready).
      return {
        activated,
        revoked,
        discardedCaptureId,
        navigating: navigating.has(input.webContentsId),
      };
    },

    revoke,

    revokeAll: (): CreatorRevocation[] =>
      [...sessions.values()].filter((session) => session.active).map(revokeActive),

    /** A cross-document main-frame navigation started on this guest. */
    navigationStarted: (webContentsId: number): CreatorRevocation | null => {
      documents.set(webContentsId, documentGeneration(webContentsId) + 1);
      navigating.add(webContentsId);
      const session = sessionForGuest(webContentsId);
      return session ? revokeActive(session) : null;
    },

    /** The main-frame navigation committed: the new document is current. */
    navigationCommitted: (webContentsId: number): void => {
      navigating.delete(webContentsId);
      // The captured document is gone; a capture still running on it cannot matter.
      inFlight.delete(webContentsId);
    },

    /**
     * The navigation ended without (or before) a commit, e.g. it failed or was
     * cancelled. True when one was pending: the old document is still shown.
     */
    navigationSettled: (webContentsId: number): boolean => navigating.delete(webContentsId),

    /** The guest is gone (destroyed or detached); its counters go with it. */
    forgetWebContents: (webContentsId: number): CreatorRevocation | null => {
      const session = sessionForGuest(webContentsId);
      documents.delete(webContentsId);
      rates.delete(webContentsId);
      navigating.delete(webContentsId);
      inFlight.delete(webContentsId);
      return session ? revokeActive(session) : null;
    },

    /** The tab is closed. Its epoch counter stays so a reused tab id keeps counting up. */
    closeTab: (tabId: string): CreatorRevocation | null => {
      const revoked = revoke(tabId);
      sessions.delete(tabId);
      return revoked;
    },

    /** The live session on this guest, while the guest still shows the document it was activated on. */
    currentDocumentSession: (webContentsId: number): CreatorSession | undefined => {
      if (navigating.has(webContentsId)) return undefined;
      const session = sessionForGuest(webContentsId);
      return session?.generation === documentGeneration(webContentsId) ? session : undefined;
    },

    isCurrent: (tabId: string, generation: number): boolean => {
      const session = sessions.get(tabId);
      return session?.active === true && session.generation === generation;
    },

    /**
     * The approval point for a send. Decided here, synchronously: an approval
     * returned before a navigation keeps its epoch; one asked for after is refused.
     */
    approve: (
      tabId: string,
      generation: number,
    ): { readonly ok: true; readonly epoch: number } | Refused => {
      const session = sessions.get(tabId);
      if (!session) return { ok: false, reason: "no_session" };
      if (!session.active) return { ok: false, reason: "inactive" };
      if (session.generation !== generation) return { ok: false, reason: "stale_generation" };
      return { ok: true, epoch: session.epoch };
    },

    admitGuestMessage: (
      input: GuestInput & { readonly kind: DesktopPreviewCreatorGuestKind },
    ):
      | { readonly ok: true; readonly session: CreatorSession; readonly payload: unknown }
      | Refused => {
      const admitted = admit(input);
      if (!admitted.ok) return admitted;
      const measured = measureGuestPayload(input.message);
      if (!measured) return { ok: false, reason: "bad_request" };
      if (measured.bytes > CREATOR_LIMITS.maxMessageBytes)
        return { ok: false, reason: "too_large" };
      if (!isRecord(measured.json)) return { ok: false, reason: "bad_request" };
      if (!takeRate(input.webContentsId, input.kind, input.now)) {
        return { ok: false, reason: "rate_limited" };
      }
      return { ok: true, session: admitted.session, payload: measured.json["payload"] ?? null };
    },

    beginCapture: (
      input: GuestInput,
    ):
      | {
          readonly ok: true;
          readonly session: CreatorSession;
          readonly capture: CreatorPendingCapture;
          /** An expired request this one replaced; its guest still waits for `done`. */
          readonly replacedRequestId: string | null;
        }
      | (Refused & { readonly requestId: string | null }) => {
      const message = isRecord(input.message) ? input.message : {};
      const rawRequestId = message["requestId"];
      const requestId =
        typeof rawRequestId === "string" && REQUEST_ID.test(rawRequestId) ? rawRequestId : null;
      const refuse = (reason: CreatorRefusal) => ({ ok: false as const, reason, requestId });
      const admitted = admit(input);
      if (!admitted.ok) return refuse(admitted.reason);
      const measured = measureGuestPayload(input.message);
      if (!measured) return refuse("bad_request");
      if (measured.bytes > CREATOR_LIMITS.maxMessageBytes) return refuse("too_large");
      if (!isRecord(measured.json)) return refuse("bad_request");
      const { purpose, timeSec, commentId, place } = measured.json;
      if (
        requestId === null ||
        (purpose !== "draft" && purpose !== "place") ||
        typeof timeSec !== "number" ||
        !Number.isFinite(timeSec) ||
        timeSec < 0 ||
        timeSec > MAX_TIME_SEC ||
        (commentId !== undefined &&
          commentId !== null &&
          (typeof commentId !== "string" || commentId.length > CREATOR_LIMITS.maxField))
      ) {
        return refuse("bad_request");
      }
      const pending = captures.get(input.tabId);
      if (pending && input.now <= pending.deadline) {
        return refuse(pending.requestId === requestId ? "duplicate_request" : "capture_busy");
      }
      const held = inFlight.get(input.webContentsId);
      if (held && input.now - held.since < CAPTURE_HOLD_MS) return refuse("capture_busy");
      inFlight.delete(input.webContentsId);
      const rate = rateOf(input.webContentsId);
      if (input.now - rate.lastCaptureAt < CAPTURE_INTERVAL_MS) return refuse("rate_limited");
      rate.lastCaptureAt = input.now;
      const capture: CreatorPendingCapture = {
        requestId,
        generation: admitted.session.generation,
        epoch: admitted.session.epoch,
        purpose,
        timeSec,
        commentId: commentId ?? null,
        place: place ?? null,
        deadline: input.now + CREATOR_LIMITS.captureTimeoutMs,
      };
      captures.set(input.tabId, capture);
      return {
        ok: true,
        session: admitted.session,
        capture,
        replacedRequestId: pending?.requestId ?? null,
      };
    },

    /** The guest froze the frame and hid its UI; returns the crop it reports. */
    captureReady: (
      input: GuestInput,
    ):
      | {
          readonly ok: true;
          readonly capture: CreatorPendingCapture;
          readonly rect: unknown;
          readonly pin: unknown;
        }
      | Refused => {
      const admitted = admit(input);
      if (!admitted.ok) return admitted;
      const message = input.message as Record<string, unknown>;
      const pending = captures.get(input.tabId);
      if (!pending || pending.requestId !== message["requestId"]) {
        return { ok: false, reason: "no_capture" };
      }
      if (input.now > pending.deadline) {
        captures.delete(input.tabId);
        return { ok: false, reason: "capture_timeout" };
      }
      if (pending.epoch !== admitted.session.epoch) return { ok: false, reason: "no_capture" };
      const measured = measureGuestPayload(message);
      if (!measured) return { ok: false, reason: "bad_request" };
      if (measured.bytes > CREATOR_LIMITS.maxMessageBytes)
        return { ok: false, reason: "too_large" };
      if (!isRecord(measured.json)) return { ok: false, reason: "bad_request" };
      // Held until `captureSettled`, past any expiry or revoke of the request.
      inFlight.set(input.webContentsId, { requestId: pending.requestId, since: input.now });
      return { ok: true, capture: pending, rect: measured.json["rect"], pin: measured.json["pin"] };
    },

    /**
     * After `capturePage`: the result counts only if the same request is still
     * pending on the same live session and document. Frees the slot either way
     * when the request matches.
     */
    finishCapture: (
      tabId: string,
      requestId: string,
    ):
      | {
          readonly ok: true;
          readonly session: CreatorSession;
          readonly capture: CreatorPendingCapture;
        }
      | Refused => {
      const pending = captures.get(tabId);
      if (!pending || pending.requestId !== requestId) return { ok: false, reason: "no_capture" };
      captures.delete(tabId);
      const session = sessions.get(tabId);
      if (!session?.active) return { ok: false, reason: "inactive" };
      if (session.generation !== pending.generation || session.epoch !== pending.epoch) {
        return { ok: false, reason: "stale_generation" };
      }
      return { ok: true, session, capture: pending };
    },

    isCapturePending: (tabId: string, requestId: string): boolean =>
      captures.get(tabId)?.requestId === requestId,

    /** The capture work for this ready (including capturePage) has settled. */
    captureSettled: (webContentsId: number, requestId: string): void => {
      if (inFlight.get(webContentsId)?.requestId === requestId) inFlight.delete(webContentsId);
    },

    /** The 5 s timer fired; true when it removed this request. */
    expireCapture: (tabId: string, requestId: string): boolean => {
      if (captures.get(tabId)?.requestId !== requestId) return false;
      captures.delete(tabId);
      return true;
    },
  };
};

export type CreatorLedger = ReturnType<typeof makeCreatorLedger>;
