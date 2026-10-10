// @effect-diagnostics globalDate:off globalTimers:off globalRandom:off cryptoRandomUUID:off - Guest preload; runs outside any Effect runtime.
/**
 * Amu Creator overlay for HyperFrames Studio, loaded by the preview preload into
 * every guest. It does nothing until main sends `creator:activate` with a
 * generation, and removes itself (restoring the Studio DOM it changed) on
 * `creator:activate { generation: null }`.
 *
 * While active it translates Studio into Japanese, shows "Amu Creator" instead
 * of the HyperFrames logo, and adds the 修正コメント panel, docked to the right
 * edge below Studio's header (see `panelLayout.ts`). The panel only
 * drafts, proposes and prepares captures; the server owns comment state and
 * the Amu window confirms every send. Buttons act only on trusted events, as a
 * guard against page scripts clicking them (not a security boundary).
 *
 * Messages to main (all `{ generation, payload }`, see `CreatorProtocol.ts`):
 * - draft `{ requestId, timeSec, comment, place: null }`, where `requestId` is
 *   the id of the capture-request sent when the placeholder card was made: the
 *   renderer attaches that request's shot to the comment the draft creates,
 *   dedupes drafts by it and reports `draftKeys` back
 * - update `{ commentId, expectedRevision, comment }`
 * - place `{ requestId, commentId, expectedRevision, place }`, then a
 *   capture-request `{ requestId, purpose: "place", commentId, place }` with the
 *   same `requestId` (the renderer pairs the shot with its place by it),
 *   centered on the point
 * - delete `{ commentId }`, confirm-by-user `{ commentId }`
 * - propose `{ commentIds }`, cancel `{ proposalId }`
 */
import type {
  CreatorComment,
  CreatorPlace,
  DesktopPreviewCreatorGuestKind,
} from "@t3tools/contracts";
import { ipcRenderer } from "electron";

import {
  CREATOR_ACTIVATE_CHANNEL,
  CREATOR_CAPTURE_BEGIN_CHANNEL,
  CREATOR_CAPTURE_DONE_CHANNEL,
  CREATOR_CAPTURE_READY_CHANNEL,
  CREATOR_CAPTURE_REQUEST_CHANNEL,
  CREATOR_GUEST_CHANNELS,
  CREATOR_REFUSED_CHANNEL,
  CREATOR_STATE_CHANNEL,
} from "../CreatorProtocol.ts";
import { normalizePoint, pinCropRect } from "../creatorGeometry.ts";
import { createCaptureClient, type CaptureClient, type CaptureSpec } from "./captureClient.ts";
import {
  attachClosedShadow,
  composedPath,
  isTrustedEvent,
  listen,
  NativeResizeObserver,
  stopImmediatePropagation,
  stopPropagation,
  swallow,
} from "./nativeDom.ts";
import { layoutPanel, type PanelLayout } from "./panelLayout.ts";
import { installPanelShield } from "./panelShield.ts";
import {
  bindPlaceholders,
  commentActions,
  commentStatusLabel,
  formatTime,
  placeMessages,
  readPanelState,
  reconcileEdit,
  sendableIds,
  type PanelState,
} from "./panelState.ts";
import { intersectRect } from "./playerChrome.ts";
import { sceneButtons } from "./sceneNames.ts";
import { createRateBudget, createUpdateScheduler, type UpdateScheduler } from "./sendPacer.ts";
import * as studio from "./studioDom.ts";

const BRAND = "Amu Creator";
const WAIT_NOTICE = "少し間をあけてください";
const REFUSED_NOTICE = "送れませんでした（内容が大きすぎるか、形式が正しくありません）";
const UNSAVED_NOTICE = "保存が終わるまでお待ちください";
const BROKEN_NOTICE = "Amu Creator の一部が動いていません（HyperFrames の更新の影響）";
const CONFIRM_NOTE = "Amu の画面で送信を確定してください";
const TICK_MS = 1_000;
const SCENE_REFRESH_TICKS = 3;
const BROKEN_AFTER_MS = 5_000;
/** After this, an unbound draft shows 「保存を確認中…」 and a manual 「もう一度保存」. */
const DRAFT_CHECK_AFTER_MS = 8_000;
const AWAIT_REVISION_MS = 3_000;
const REFUSAL_MATCH_MS = 2_000;
const DELETE_CONFIRM_MS = 3_000;
const SPEEDS = [1, 1.5, 2, 3] as const;
const COMMENT_HERE = "▶ いま止めた位置にコメント";

const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.panel { width: 100%; max-height: calc(100vh - 60px); display: flex; flex-direction: column;
  background: #121a26; color: #e7edf4; border: 2px solid #39d0b8; border-radius: 12px;
  font: 13px/1.5 system-ui, -apple-system, "Hiragino Sans", sans-serif;
  box-shadow: 0 0 22px rgba(57, 208, 184, .35); overflow: hidden; }
.bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 4px 6px 4px 0;
  border-bottom: 1px solid #2a3850; }
.tab { all: unset; cursor: pointer; padding: 4px 6px 4px 12px; font-weight: 800; display: flex;
  justify-content: space-between; gap: 8px; flex: 1; min-width: max-content; }
.body { overflow: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.collapsed .body, .collapsed .foot { display: none; }
.collapsed .bar { border-bottom: 0; }
.quick { display: none; background: #f2f5f8; color: #121a26; border: 0; border-radius: 6px;
  padding: 5px 8px; font-weight: 800; font-size: 12px; margin-left: 6px; }
.size { flex: none; }
.compact .quick { display: block; }
.compact .tab { font-size: 12px; padding-left: 4px; }
.compact .bar { border-bottom: 0; }
.compact .foot, .compact .body > .big, .compact .body > details { display: none; }
.compact .body { padding: 8px 10px; border-top: 1px solid #2a3850; }
.compact .card:not(.editing):not(:focus-within) { display: none; }
.compact .body:not(:has(.card.editing, .card:focus-within, .banner:not([hidden]))) { display: none; }
.foot { padding: 8px 12px 12px; border-top: 1px solid #2a3850; display: flex; flex-direction: column; gap: 8px; }
button { font: inherit; color: inherit; cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }
.big { width: 100%; background: #f2f5f8; color: #121a26; border: 0; border-radius: 8px;
  padding: 10px; font-weight: 800; font-size: 14px; }
.banner { padding: 6px 8px; border-radius: 6px; font-size: 12px; }
.warn { background: #3a1f1f; color: #ffb4a8; }
.info { background: #3a2f12; color: #f3cf7a; }
.note { background: #1d3346; color: #9fd7ff; }
.card { background: #18233a; border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.head { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.time { background: #203250; color: #7cc4ff; border: 0; border-radius: 5px; padding: 1px 7px; font-weight: 700; }
.status { font-size: 11px; color: #9fb0c4; }
.shot { font-size: 11px; color: #f3cf7a; }
textarea { width: 100%; background: #0f1622; color: #e7edf4; border: 1px solid #33435c;
  border-radius: 6px; padding: 6px; font: 13px system-ui, -apple-system, "Hiragino Sans", sans-serif; resize: vertical; }
.row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 11px; color: #c8d3df; }
.mini { border: 1px solid #33435c; border-radius: 5px; padding: 1px 8px; background: transparent; color: #c8d3df; font-size: 11px; }
.actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
.ai { font-size: 12px; color: #b9e6c9; }
details summary { cursor: pointer; font-size: 12px; color: #9fb0c4; }
.sendall { width: 100%; background: #2f6f5e; color: #fff; border: 0; border-radius: 8px; padding: 9px; font-weight: 800; }
.track { position: relative; height: 8px; border-radius: 4px; background: #2a3850; cursor: pointer; margin: 6px 0; }
.fill { position: absolute; left: 0; top: 0; bottom: 0; background: #e2b25a; border-radius: 4px; }
.mark { all: unset; position: absolute; top: -4px; width: 4px; height: 16px; background: #39d0b8; border-radius: 2px; cursor: pointer; }
.chips { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; font-size: 12px; color: #9fb0c4; }
.chip { border: 1px solid #33435c; border-radius: 6px; padding: 2px 8px; background: #18233a; color: #e7edf4; font-size: 12px; }
.chip.on { border-color: #e2b25a; color: #e2b25a; }
[hidden] { display: none !important; }
`;

type Placeholder = {
  readonly requestId: string;
  readonly timeSec: number;
  /** Text sent with `creator:draft`; `null` while not sent. */
  sentText: string | null;
  sentAt: number;
  /** Deleted while its draft was in flight: delete the comment once it binds. */
  deleted: boolean;
};

type CardView = {
  key: string;
  readonly root: HTMLDivElement;
  readonly time: HTMLButtonElement;
  readonly status: HTMLSpanElement;
  readonly shot: HTMLSpanElement;
  readonly text: HTMLTextAreaElement;
  readonly placeText: HTMLSpanElement;
  readonly placeButton: HTMLButtonElement;
  readonly ai: HTMLDivElement;
  readonly retry: HTMLButtonElement;
  readonly sendOne: HTMLButtonElement;
  readonly remove: HTMLButtonElement;
  readonly cancel: HTMLButtonElement;
  readonly confirm: HTMLButtonElement;
  capture: "pending" | "ok" | "failed" | null;
  deleteArmedAt: number;
};

type Session = ReturnType<typeof createSession>;

const make = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Runs `handler` only for a real user action. */
const trusted =
  <E extends Event>(handler: (event: E) => void) =>
  (event: E) => {
    if (isTrustedEvent(event)) handler(event);
  };

const newRequestId = (): string =>
  typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID()
    : `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

const placeText = (place: CreatorPlace): string =>
  place.elementLabel ??
  place.elementSelector ??
  place.compositionFile ??
  `x ${place.x.toFixed(2)}, y ${place.y.toFixed(2)}`;

function createSession(initialGeneration: number) {
  let generation = initialGeneration;
  let state: PanelState | null = null;
  const knownIds = new Set<string>();
  const placeholders: Placeholder[] = [];
  const views = new Map<string, CardView>();
  /**
   * commentId -> the user's text the server does not show yet. Kept until a
   * state shows exactly that text; the textarea is never overwritten meanwhile.
   */
  const localText = new Map<string, string>();
  /** commentId -> the revision the in-flight update was sent against. */
  const awaiting = new Map<string, { revision: number; at: number }>();
  /** commentId -> the revision a place was sent against (shows 「保存中…」). */
  const placeAwaiting = new Map<string, { revision: number; at: number }>();
  /** Comments to delete: placeholders deleted while their draft was in flight. */
  const pendingDeletes = new Set<string>();
  const lastSent = new Map<DesktopPreviewCreatorGuestKind, { key: string; at: number }>();
  let placing: { commentId: string; timeSec: number } | null = null;
  let justProposed = false;
  let collapsed = false;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFillAt = 0;
  let sceneSignature = "";
  let markerSignature = "";
  let observedPlayer: { player: HTMLElement; remove: () => void } | null = null;
  let hooked: { doc: Document; remove: () => void } | null = null;
  let ticks = 0;
  const startedAt = Date.now();
  const cleanups: Array<() => void> = [];
  const budget = createRateBudget();

  // ---- DOM ----
  const host = make("div");
  host.setAttribute("data-amu-creator", "");
  // top, right and width come from `applyLayout`.
  host.style.cssText = "position:fixed;top:48px;right:12px;width:340px;z-index:2147483647";
  const shadow = attachClosedShadow(host);
  const style = make("style");
  style.textContent = PANEL_CSS;
  const panel = make("div", "panel");
  const bar = make("div", "bar");
  // Compact mode's own comment button; the full panel uses `big`.
  const quick = make("button", "quick", COMMENT_HERE);
  const tab = make("button", "tab");
  const tabLabel = make("span");
  const tabArrow = make("span", undefined, "▾");
  tab.append(tabLabel, tabArrow);
  const sizeToggle = make("button", "mini size");
  sizeToggle.hidden = true;
  bar.append(quick, tab, sizeToggle);
  const body = make("div", "body");
  const broken = make("div", "banner warn", BROKEN_NOTICE);
  broken.hidden = true;
  const notice = make("div", "banner info");
  notice.hidden = true;
  const big = make("button", "big", COMMENT_HERE);
  const placingHint = make(
    "div",
    "banner info",
    "プレビューの直したい場所を 1 回クリックしてください（Esc で取り消し）",
  );
  placingHint.hidden = true;
  const list = make("div");
  list.style.cssText = "display:flex;flex-direction:column;gap:8px";
  const confirmed = make("details");
  const confirmedSummary = make("summary");
  const confirmedList = make("div");
  confirmedList.style.cssText = "display:flex;flex-direction:column;gap:8px;margin-top:6px";
  confirmed.append(confirmedSummary, confirmedList);
  confirmed.hidden = true;
  body.append(broken, notice, big, placingHint, list, confirmed);
  const foot = make("div", "foot");
  const sendAll = make("button", "sendall");
  const confirmNote = make("div", "banner note", CONFIRM_NOTE);
  confirmNote.hidden = true;
  const track = make("div", "track");
  const fill = make("div", "fill");
  track.append(fill);
  const speeds = make("div", "chips", "倍速 ");
  const speedButtons = SPEEDS.map((rate) => {
    const button = make("button", "chip", `${rate}x`);
    listen(
      button,
      "click",
      trusted(() => {
        if (capture.frozen()) return;
        studio.setPlaybackRate(rate);
        refreshSpeeds();
      }),
    );
    speeds.append(button);
    return { rate, button };
  });
  const scenes = make("div", "chips");
  foot.append(sendAll, confirmNote, track, speeds, scenes);
  panel.append(bar, body, foot);
  shadow.append(style, panel);

  const isOurs = (node: Node | null): boolean =>
    node !== null && (node === host || host.contains(node));
  const fromPanel = (event: Event): boolean => composedPath(event).includes(host);
  const focusedInPanel = (): Element | null => shadow.activeElement;

  // ---- notices ----
  const showNotice = (text: string) => {
    notice.textContent = text;
    notice.hidden = false;
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      notice.hidden = true;
      noticeTimer = null;
    }, 3_000);
  };

  // ---- sending ----
  const send = (
    kind: DesktopPreviewCreatorGuestKind,
    key: string,
    payload: Record<string, unknown>,
    options: { quiet?: boolean } = {},
  ): boolean => {
    if (!budget.take(kind, Date.now())) {
      if (options.quiet !== true) showNotice(WAIT_NOTICE);
      return false;
    }
    lastSent.set(kind, { key, at: Date.now() });
    ipcRenderer.send(CREATOR_GUEST_CHANNELS[kind], { generation, payload });
    return true;
  };

  const commentById = (id: string): CreatorComment | undefined =>
    state?.comments.find((comment) => comment.id === id);
  const placeholderKey = (requestId: string) => `p:${requestId}`;
  const placeholderOf = (key: string) =>
    placeholders.find((entry) => placeholderKey(entry.requestId) === key);

  const sendDraft = (placeholder: Placeholder, text: string, quiet: boolean): boolean => {
    const ok = send(
      "draft",
      placeholderKey(placeholder.requestId),
      {
        requestId: placeholder.requestId,
        timeSec: placeholder.timeSec,
        comment: text,
        place: null,
      },
      { quiet },
    );
    if (ok) {
      placeholder.sentText = text;
      placeholder.sentAt = Date.now();
    }
    return ok;
  };

  const scheduler: UpdateScheduler = createUpdateScheduler({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    send: (key, value) => {
      const placeholder = placeholderOf(key);
      if (placeholder !== undefined) {
        const text = value.trim();
        // Saving: further typing waits until the card is bound to its comment.
        if (placeholder.sentText !== null || placeholder.deleted) return placeholder.deleted;
        if (text === "") return true;
        const ok = sendDraft(placeholder, text, true);
        if (ok) renderCards();
        return ok;
      }
      const comment = commentById(key);
      if (comment === undefined) {
        localText.delete(key);
        return true;
      }
      const text = (localText.get(key) ?? value).trim();
      if (text === "") return true;
      if (text === comment.comment) {
        localText.delete(key);
        return true;
      }
      if (comment.status === "sending") return false;
      const waiting = awaiting.get(key);
      if (
        waiting !== undefined &&
        waiting.revision === comment.revision &&
        Date.now() - waiting.at < AWAIT_REVISION_MS
      ) {
        return false;
      }
      const ok = send(
        "update",
        key,
        { commentId: key, expectedRevision: comment.revision, comment: text },
        { quiet: true },
      );
      if (ok) awaiting.set(key, { revision: comment.revision, at: Date.now() });
      return ok;
    },
  });

  const isDirty = (key: string): boolean =>
    scheduler.pending(key) ||
    localText.has(key) ||
    awaiting.has(key) ||
    placeAwaiting.has(key) ||
    placeholderOf(key) !== undefined;

  /** Some card holds text the server does not have yet. */
  const hasUnsentText = (): boolean =>
    placeholders.some((entry) => {
      if (entry.deleted) return false;
      const view = views.get(placeholderKey(entry.requestId));
      return (view?.text.value.trim() ?? "") !== "";
    }) ||
    localText.size > 0 ||
    awaiting.size > 0 ||
    [...views.keys()].some((key) => scheduler.pending(key));

  const flushDeletes = () => {
    for (const id of pendingDeletes) {
      if (commentById(id) === undefined) {
        pendingDeletes.delete(id);
        continue;
      }
      if (send("delete", id, { commentId: id }, { quiet: true })) pendingDeletes.delete(id);
    }
  };

  // ---- capture ----
  /** The shot is the composition (never the player box), cut to what the preview shows. */
  const measure = (spec: CaptureSpec) => {
    const comp = studio.compositionRect();
    const visible = comp === null ? null : studio.clipToPreview(comp);
    if (comp === null || visible === null) return null;
    if (spec.pin === null) return { rect: visible };
    const crop = pinCropRect(comp, spec.pin.x, spec.pin.y, {
      width: comp.width / 2,
      height: comp.height / 2,
    });
    return {
      rect: intersectRect(crop, visible) ?? crop,
      pin: { x: comp.x + spec.pin.x * comp.width, y: comp.y + spec.pin.y * comp.height },
    };
  };
  /** Placeholder key, or the comment the placeholder became. */
  const boundRequests = new Map<string, string>();
  const viewKeyForRequest = (requestId: string): string =>
    boundRequests.get(requestId) ?? placeholderKey(requestId);
  let restoreFocus: Element | null = null;
  let restoreChrome: (() => void) | null = null;
  const capture: CaptureClient = createCaptureClient({
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    sendRequest: (spec) =>
      ipcRenderer.send(CREATOR_CAPTURE_REQUEST_CHANNEL, {
        generation,
        requestId: spec.requestId,
        purpose: spec.purpose,
        timeSec: spec.timeSec,
        commentId: spec.commentId,
        place: spec.place,
      }),
    sendReady: (input) => ipcRenderer.send(CREATOR_CAPTURE_READY_CHANNEL, { generation, ...input }),
    pause: studio.pausePlayer,
    seek: studio.seekAndSettle,
    waitFrames: studio.waitFrames,
    // Opacity, not visibility: the textarea keeps focus and typing while hidden.
    // Studio's controls over the preview are hidden too, and put back exactly in `show`.
    hide: () => {
      restoreFocus = focusedInPanel();
      host.style.opacity = "0";
      host.style.pointerEvents = "none";
      restoreChrome?.();
      const comp = studio.compositionRect();
      const visible = comp === null ? null : studio.clipToPreview(comp);
      try {
        restoreChrome = studio.hidePlayerChrome(visible, isOurs);
      } catch {
        restoreChrome = null;
      }
    },
    show: () => {
      restoreChrome?.();
      restoreChrome = null;
      host.style.opacity = "";
      host.style.pointerEvents = "";
      if (
        restoreFocus instanceof HTMLElement &&
        restoreFocus.isConnected &&
        focusedInPanel() === null
      ) {
        restoreFocus.focus();
      }
      restoreFocus = null;
    },
    measure,
    onSettled: (spec, ok, began) => {
      const key = spec.purpose === "draft" ? viewKeyForRequest(spec.requestId) : spec.commentId;
      const view = key === null ? undefined : views.get(key);
      if (view !== undefined) view.capture = ok ? "ok" : "failed";
      // Main refused without a begin: another capture or its 1-per-second gate.
      if (!ok && !began) showNotice(WAIT_NOTICE);
      render();
    },
  });

  // ---- actions ----
  const commentHere = () => {
    if (capture.busy()) return;
    if (studio.findPlayer() === null) {
      showNotice(BROKEN_NOTICE);
      return;
    }
    studio.pausePlayer();
    const timeSec = studio.currentTime() ?? 0;
    const requestId = newRequestId();
    placeholders.unshift({ requestId, timeSec, sentText: null, sentAt: 0, deleted: false });
    render();
    const view = views.get(placeholderKey(requestId));
    if (view !== undefined) {
      view.capture = "pending";
      view.text.focus();
      updateCard(view);
    }
    capture.request({
      requestId,
      purpose: "draft",
      timeSec,
      commentId: null,
      place: null,
      pin: null,
    });
  };

  const startPlacing = (commentId: string) => {
    if (capture.busy()) return;
    if (placing?.commentId === commentId) {
      placing = null;
      render();
      return;
    }
    const comment = commentById(commentId);
    if (comment === undefined) return;
    studio.pausePlayer();
    // The user clicks on the frame the comment is about.
    studio.seekTo(comment.timeSec);
    placing = { commentId, timeSec: comment.timeSec };
    render();
  };

  /** Handles the one placing click; true when it was taken. */
  const placeAt = (event: MouseEvent, x: number, y: number): boolean => {
    if (placing === null || !isTrustedEvent(event) || capture.busy()) return false;
    const comp = studio.compositionRect();
    const point = comp === null ? null : normalizePoint(comp, x, y);
    if (point === null) return false;
    const target = placing;
    placing = null;
    const comment = commentById(target.commentId);
    if (comment === undefined) {
      render();
      return true;
    }
    const place: CreatorPlace = { x: point.x, y: point.y, ...studio.elementAt(point.x, point.y) };
    const messages = placeMessages({
      requestId: newRequestId(),
      comment: { id: comment.id, revision: comment.revision, timeSec: target.timeSec },
      place,
      pin: point,
    });
    if (send("place", comment.id, messages.place)) {
      placeAwaiting.set(comment.id, { revision: comment.revision, at: Date.now() });
      const view = views.get(comment.id);
      if (view !== undefined) view.capture = "pending";
      capture.request(messages.capture);
    }
    render();
    return true;
  };

  const removeCard = (view: CardView) => {
    const now = Date.now();
    if (now - view.deleteArmedAt > DELETE_CONFIRM_MS) {
      view.deleteArmedAt = now;
      updateCard(view);
      setTimeout(() => updateCard(view), DELETE_CONFIRM_MS + 50);
      return;
    }
    view.deleteArmedAt = 0;
    const placeholder = placeholderOf(view.key);
    if (placeholder !== undefined) {
      scheduler.cancel(view.key);
      // Its draft may already be saved: delete that comment once it binds.
      if (placeholder.sentText === null) placeholders.splice(placeholders.indexOf(placeholder), 1);
      else placeholder.deleted = true;
      render();
      return;
    }
    if (send("delete", view.key, { commentId: view.key })) {
      scheduler.cancel(view.key);
      localText.delete(view.key);
      awaiting.delete(view.key);
    }
  };

  const propose = (commentIds: string[]) => {
    if (commentIds.length === 0) return;
    if (hasUnsentText() && commentIds.length > 1) {
      showNotice(UNSAVED_NOTICE);
      return;
    }
    if (commentIds.some(isDirty)) {
      showNotice(UNSAVED_NOTICE);
      return;
    }
    if (send("propose", commentIds.join(","), { commentIds })) {
      justProposed = true;
      render();
    }
  };

  // ---- cards ----
  const createCard = (key: string): CardView => {
    const root = make("div", "card");
    const head = make("div", "head");
    const time = make("button", "time");
    const status = make("span", "status");
    const shot = make("span", "shot");
    head.append(time, status, shot);
    const text = make("textarea");
    text.rows = 2;
    text.placeholder = "直してほしいことを書く";
    text.maxLength = 2_000;
    const row = make("div", "row");
    const placeLabel = make("span");
    const placeButton = make("button", "mini");
    row.append(placeLabel, placeButton);
    const ai = make("div", "ai");
    const actions = make("div", "actions");
    const retry = make("button", "mini", "もう一度保存");
    const sendOne = make("button", "mini", "これだけ送る");
    const remove = make("button", "mini", "削除");
    const cancel = make("button", "mini", "取り消し");
    const confirm = make("button", "mini", "確認済みにする");
    actions.append(retry, cancel, confirm, sendOne, remove);
    root.append(head, text, row, ai, actions);
    const view: CardView = {
      key,
      root,
      time,
      status,
      shot,
      text,
      placeText: placeLabel,
      placeButton,
      ai,
      retry,
      sendOne,
      remove,
      cancel,
      confirm,
      capture: null,
      deleteArmedAt: 0,
    };
    listen(
      time,
      "click",
      trusted(() => {
        if (capture.frozen()) return;
        const timeSec = commentById(view.key)?.timeSec ?? placeholderOf(view.key)?.timeSec;
        if (timeSec === undefined) return;
        studio.pausePlayer();
        studio.seekTo(timeSec);
      }),
    );
    // Trusted input arrives through the panel shield (`onShielded`); this covers a guest without it.
    listen(
      text,
      "input",
      trusted(() => onTextInput(view)),
    );
    listen(text, "blur", () => scheduler.flush(view.key));
    listen(
      placeButton,
      "click",
      trusted(() => startPlacing(view.key)),
    );
    listen(
      retry,
      "click",
      trusted(() => {
        // Same requestId: the renderer dedupes drafts by it.
        const placeholder = placeholderOf(view.key);
        const value = text.value.trim();
        if (placeholder === undefined || placeholder.sentText === null || value === "") return;
        if (sendDraft(placeholder, value, false)) updateCard(view);
      }),
    );
    listen(
      sendOne,
      "click",
      trusted(() => propose([view.key])),
    );
    listen(
      remove,
      "click",
      trusted(() => removeCard(view)),
    );
    listen(
      cancel,
      "click",
      trusted(() => {
        const comment = commentById(view.key);
        const proposalId =
          comment && state ? commentActions(comment, state.proposals).cancelProposalId : null;
        if (proposalId !== null) send("cancel", proposalId, { proposalId });
      }),
    );
    listen(
      confirm,
      "click",
      trusted(() => send("confirm-by-user", view.key, { commentId: view.key })),
    );
    return view;
  };

  const onTextInput = (view: CardView) => {
    if (placeholderOf(view.key) === undefined) localText.set(view.key, view.text.value);
    scheduler.change(view.key, view.text.value);
    updateCard(view);
    renderFooter();
  };

  const updateCard = (view: CardView) => {
    const placeholder = placeholderOf(view.key);
    const comment = commentById(view.key);
    // Compact mode still shows the cards being written.
    view.root.classList.toggle("editing", placeholder !== undefined || isDirty(view.key));
    const armed = Date.now() - view.deleteArmedAt <= DELETE_CONFIRM_MS;
    view.remove.textContent = armed ? "本当に削除する" : "削除";
    view.shot.textContent =
      view.capture === "pending"
        ? "撮影中…"
        : view.capture === "failed" || (view.capture === null && comment?.shot === null)
          ? "画像なし"
          : "";
    if (placeholder !== undefined) {
      const checking =
        placeholder.sentText !== null && Date.now() - placeholder.sentAt > DRAFT_CHECK_AFTER_MS;
      view.time.textContent = formatTime(placeholder.timeSec);
      view.status.textContent =
        placeholder.sentText === null ? "未保存" : checking ? "保存を確認中…" : "保存中…";
      view.placeText.textContent = "";
      view.placeButton.textContent = "＋ 場所も指定する（任意）";
      view.placeButton.disabled = true;
      view.placeButton.title = "先に指示を書いてください";
      view.ai.hidden = true;
      view.retry.hidden = !checking;
      view.sendOne.hidden = false;
      view.sendOne.disabled = true;
      view.remove.hidden = false;
      view.cancel.hidden = true;
      view.confirm.hidden = true;
      return;
    }
    if (comment === undefined || state === null) return;
    const actions = commentActions(comment, state.proposals);
    const dirty = isDirty(view.key);
    view.time.textContent = formatTime(comment.timeSec);
    view.status.textContent = dirty
      ? "保存中…"
      : commentStatusLabel(comment, state.proposals, state.projectRevision);
    view.text.disabled = comment.status === "sending";
    // Never overwrite the user's unsent text or the textarea they are typing in.
    if (
      !localText.has(view.key) &&
      !scheduler.pending(view.key) &&
      focusedInPanel() !== view.text &&
      view.text.value !== comment.comment
    ) {
      view.text.value = comment.comment;
    }
    view.placeText.textContent = comment.place === null ? "" : `場所：${placeText(comment.place)}`;
    view.placeButton.textContent =
      placing?.commentId === comment.id
        ? "クリック待ち…（取り消す）"
        : comment.place === null
          ? "＋ 場所も指定する（任意）"
          : "場所を指定し直す";
    view.placeButton.disabled = comment.status === "sending";
    view.placeButton.title = "";
    view.ai.hidden = comment.resolvedNote === null || comment.resolvedNote === "";
    view.ai.textContent = comment.resolvedNote === null ? "" : `AI：${comment.resolvedNote}`;
    view.retry.hidden = true;
    view.sendOne.hidden = !actions.sendOne;
    view.sendOne.disabled = dirty;
    view.sendOne.title = dirty ? UNSAVED_NOTICE : "";
    view.remove.hidden = !actions.remove;
    view.cancel.hidden = actions.cancelProposalId === null;
    view.confirm.hidden = !actions.confirm;
  };

  /** Puts `nodes` into `container` in order without moving nodes already in place (keeps focus). */
  const placeInOrder = (container: HTMLElement, nodes: ReadonlyArray<HTMLElement>) => {
    nodes.forEach((node, index) => {
      if (container.children[index] !== node)
        container.insertBefore(node, container.children[index] ?? null);
    });
    while (container.children.length > nodes.length) container.lastElementChild?.remove();
  };

  const renderCards = () => {
    const open: CardView[] = [];
    const done: CardView[] = [];
    const wanted = new Set<string>();
    const viewFor = (key: string) => {
      wanted.add(key);
      let view = views.get(key);
      if (view === undefined) {
        view = createCard(key);
        views.set(key, view);
      }
      updateCard(view);
      return view;
    };
    for (const placeholder of placeholders) {
      if (!placeholder.deleted) open.push(viewFor(placeholderKey(placeholder.requestId)));
    }
    const comments = [...(state?.comments ?? [])]
      .filter((comment) => !pendingDeletes.has(comment.id))
      .toSorted((a, b) => b.number - a.number);
    for (const comment of comments) {
      (comment.status === "confirmed" ? done : open).push(viewFor(comment.id));
    }
    for (const [key, view] of views) {
      if (!wanted.has(key)) {
        view.root.remove();
        views.delete(key);
      }
    }
    placeInOrder(
      list,
      open.map((view) => view.root),
    );
    placeInOrder(
      confirmedList,
      done.map((view) => view.root),
    );
    confirmed.hidden = done.length === 0;
    confirmedSummary.textContent = `確認済み（${done.length} 件）`;
    tabLabel.textContent = `修正コメント（${open.length}）`;
  };

  const renderFooter = () => {
    const ids = state === null ? [] : sendableIds(state.comments);
    const unsent = hasUnsentText();
    sendAll.textContent = unsent ? "保存中…" : `まとめて送る（${ids.length} 件）`;
    sendAll.disabled = ids.length === 0 || unsent;
    const proposed = state?.comments.some((comment) => comment.status === "proposed") ?? false;
    confirmNote.hidden = !(justProposed || proposed);
    big.disabled = capture.busy();
    big.textContent = capture.busy() ? "撮影中…" : COMMENT_HERE;
    quick.disabled = big.disabled;
    quick.textContent = big.textContent;
    placingHint.hidden = placing === null;
  };

  const refreshSpeeds = () => {
    const rate = studio.playbackRate();
    for (const { rate: value, button } of speedButtons) {
      button.classList.toggle("on", Math.abs(value - rate) < 0.01);
    }
  };

  const refreshFill = () => {
    const total = studio.duration();
    const now = studio.currentTime() ?? 0;
    fill.style.width = total > 0 ? `${Math.min(100, (now / total) * 100)}%` : "0%";
  };

  const refreshMarkers = () => {
    const total = studio.duration();
    const comments = state?.comments ?? [];
    const signature = `${total}|${comments.map((c) => `${c.id}:${c.timeSec}`).join(",")}`;
    if (signature === markerSignature) return;
    markerSignature = signature;
    for (const mark of track.querySelectorAll(".mark")) mark.remove();
    if (total <= 0) return;
    for (const comment of comments) {
      const mark = make("button", "mark");
      mark.style.left = `${Math.min(100, (comment.timeSec / total) * 100)}%`;
      mark.title = `#${comment.number} ${formatTime(comment.timeSec)}`;
      listen(
        mark,
        "click",
        trusted((event) => {
          stopPropagation(event);
          if (capture.frozen()) return;
          studio.pausePlayer();
          studio.seekTo(comment.timeSec);
        }),
      );
      track.append(mark);
    }
  };

  const refreshScenes = () => {
    const buttons = sceneButtons(studio.readScenes());
    const signature = buttons.map((scene) => `${scene.label}@${scene.start}`).join("|");
    if (signature === sceneSignature) return;
    sceneSignature = signature;
    scenes.replaceChildren(make("span", undefined, buttons.length === 0 ? "" : "場面へ移動 "));
    for (const scene of buttons) {
      const button = make("button", "chip", scene.label);
      listen(
        button,
        "click",
        trusted(() => {
          if (capture.frozen()) return;
          studio.pausePlayer();
          studio.seekTo(scene.start + 0.5);
        }),
      );
      scenes.append(button);
    }
  };

  const render = () => {
    renderCards();
    renderFooter();
    refreshMarkers();
  };

  // ---- state from the renderer ----
  const applyState = (next: PanelState) => {
    const bound = bindPlaceholders(placeholders, knownIds, next);
    for (const [requestId, commentId] of bound) {
      const key = placeholderKey(requestId);
      const view = views.get(key);
      const index = placeholders.findIndex((entry) => entry.requestId === requestId);
      const placeholder = placeholders[index];
      if (index >= 0) placeholders.splice(index, 1);
      boundRequests.set(requestId, commentId);
      if (placeholder?.deleted === true) {
        pendingDeletes.add(commentId);
        continue;
      }
      scheduler.rekey(key, commentId);
      if (view !== undefined) {
        views.delete(key);
        view.key = commentId;
        views.set(commentId, view);
        // Typed after the draft went out: that text becomes the comment's local edit.
        const current = view.text.value;
        if (current.trim() !== placeholder?.sentText) {
          localText.set(commentId, current);
          if (!scheduler.pending(commentId)) scheduler.change(commentId, current);
        }
      }
    }
    state = next;
    for (const comment of next.comments) knownIds.add(comment.id);
    for (const [id, local] of localText) {
      const comment = commentById(id);
      if (comment === undefined) {
        localText.delete(id);
        awaiting.delete(id);
        scheduler.cancel(id);
        continue;
      }
      const decision = reconcileEdit({
        local,
        serverText: comment.comment,
        serverRevision: comment.revision,
        sentAgainst: awaiting.get(id)?.revision ?? null,
      });
      if (decision === "clear") {
        localText.delete(id);
        awaiting.delete(id);
      } else if (decision === "resend") {
        // Another change got in first; the user's text goes again against the new revision.
        awaiting.delete(id);
        if (!scheduler.pending(id)) scheduler.change(id, local);
      }
    }
    for (const id of awaiting.keys()) if (!localText.has(id)) awaiting.delete(id);
    for (const [id, waiting] of placeAwaiting) {
      const comment = commentById(id);
      if (comment === undefined || comment.revision > waiting.revision) placeAwaiting.delete(id);
    }
    justProposed = false;
    if (next.notice !== null) showNotice(next.notice);
    flushDeletes();
    render();
  };

  const onRefused = (kind: string, reason: string) => {
    const rateLimited = reason === "rate_limited";
    showNotice(rateLimited ? WAIT_NOTICE : REFUSED_NOTICE);
    const sent = lastSent.get(kind as DesktopPreviewCreatorGuestKind);
    if (sent === undefined || Date.now() - sent.at > REFUSAL_MATCH_MS) return;
    if (kind === "draft") {
      const placeholder = placeholderOf(sent.key);
      const view = views.get(sent.key);
      if (placeholder !== undefined) {
        placeholder.sentText = null;
        // Only a rate refusal is retried; a too-large or malformed one waits for new typing.
        if (rateLimited && view !== undefined) scheduler.change(sent.key, view.text.value);
      }
    } else if (kind === "update") {
      awaiting.delete(sent.key);
      const local = localText.get(sent.key);
      if (rateLimited && local !== undefined) scheduler.change(sent.key, local);
    } else if (kind === "place") {
      placeAwaiting.delete(sent.key);
    } else if (kind === "delete" && rateLimited && commentById(sent.key) !== undefined) {
      pendingDeletes.add(sent.key);
    }
    render();
  };

  // ---- input guards ----
  /** While capturing or placing, Studio must not see presses on the preview or keys. */
  const guardPointer = (event: MouseEvent, x: number, y: number) => {
    if (fromPanel(event)) return;
    if (capture.frozen()) {
      swallow(event);
      return;
    }
    if (placing === null) return;
    if (event.type === "click") {
      if (placeAt(event, x, y)) swallow(event);
      return;
    }
    const comp = studio.compositionRect();
    if (comp !== null && normalizePoint(comp, x, y) !== null) swallow(event);
  };
  const guardKey = (event: KeyboardEvent) => {
    if (fromPanel(event)) return;
    if (placing !== null && event.key === "Escape" && event.type === "keydown") {
      placing = null;
      render();
      swallow(event);
      return;
    }
    if (capture.frozen()) swallow(event);
  };
  const POINTER_EVENTS = ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick"];
  const FROZEN_EVENTS = ["wheel", "contextmenu"];
  const KEY_EVENTS = ["keydown", "keyup", "keypress"];
  const CAPTURING = { capture: true, passive: false } as const;
  for (const type of POINTER_EVENTS) {
    cleanups.push(
      listen<MouseEvent>(
        window,
        type,
        (event) => guardPointer(event, event.clientX, event.clientY),
        CAPTURING,
      ),
    );
  }
  for (const type of FROZEN_EVENTS) {
    cleanups.push(
      listen(
        window,
        type,
        (event) => {
          if (capture.frozen() && !fromPanel(event)) swallow(event);
        },
        CAPTURING,
      ),
    );
  }
  for (const type of KEY_EVENTS) cleanups.push(listen(window, type, guardKey, CAPTURING));
  /**
   * The preview iframe gets its own listeners; its events never reach this
   * window. Only the current composition document is held: a reload drops the
   * old one.
   */
  const hookComposition = () => {
    const doc = studio.compositionDocument();
    if (doc === hooked?.doc) return;
    hooked?.remove();
    hooked = null;
    if (doc === null) return;
    const removers = [
      ...POINTER_EVENTS.map((type) =>
        listen<MouseEvent>(
          doc,
          type,
          (event) => {
            const point = studio.iframePointToViewport(event.clientX, event.clientY);
            if (point !== null) guardPointer(event, point.x, point.y);
          },
          CAPTURING,
        ),
      ),
      ...FROZEN_EVENTS.map((type) =>
        listen(
          doc,
          type,
          (event) => {
            if (capture.frozen()) swallow(event);
          },
          CAPTURING,
        ),
      ),
      // Esc cancels placing here too, and keys freeze during a capture.
      ...KEY_EVENTS.map((type) => listen(doc, type, guardKey, CAPTURING)),
    ];
    hooked = { doc, remove: () => removers.forEach((remove) => remove()) };
  };
  // Clicks in the panel do not deselect in Studio. Keys never get here: the panel shield stops them.
  for (const type of ["pointerdown", "mousedown", "click"]) {
    listen(panel, type, stopPropagation);
  }
  listen(
    tab,
    "click",
    trusted(() => {
      collapsed = !collapsed;
      panel.classList.toggle("collapsed", collapsed);
      tabArrow.textContent = collapsed ? "▸" : "▾";
    }),
  );
  listen(big, "click", trusted(commentHere));
  listen(quick, "click", trusted(commentHere));
  listen(
    sizeToggle,
    "click",
    trusted(() => {
      userExpanded = !userExpanded;
      applyLayout();
    }),
  );
  listen(
    sendAll,
    "click",
    trusted(() => propose(state === null ? [] : sendableIds(state.comments))),
  );
  listen<MouseEvent>(
    track,
    "click",
    trusted((event) => {
      if (capture.frozen()) return;
      const total = studio.duration();
      const box = track.getBoundingClientRect();
      if (total <= 0 || box.width <= 0) return;
      studio.seekTo(((event.clientX - box.x) / box.width) * total);
      refreshFill();
    }),
  );

  // ---- placement ----
  /** The user opened the full list although it covers the video. */
  let userExpanded = false;
  let layout: PanelLayout | null = null;
  let layoutFrame: number | null = null;
  let layoutTargets: { player: Element | null; iframe: Element | null } = {
    player: null,
    iframe: null,
  };
  const applyLayout = () => {
    const comp = studio.compositionRect();
    const next = layoutPanel({
      viewport: { width: window.innerWidth, height: window.innerHeight },
      headerBottom: studio.headerBottom(),
      composition: comp === null ? null : studio.clipToPreview(comp),
      userExpanded,
    });
    if (
      layout !== null &&
      layout.top === next.top &&
      layout.width === next.width &&
      layout.maxHeight === next.maxHeight &&
      layout.crowded === next.crowded &&
      layout.compact === next.compact
    ) {
      return;
    }
    layout = next;
    host.style.top = `${next.top}px`;
    host.style.right = `${next.right}px`;
    host.style.width = `${next.width}px`;
    panel.style.maxHeight = `${next.maxHeight}px`;
    panel.classList.toggle("compact", next.compact);
    sizeToggle.hidden = !next.crowded;
    sizeToggle.textContent = next.compact ? "一覧を開く" : "小さくする";
    sizeToggle.title = next.compact
      ? "コメントの一覧を開きます（動画に重なります）"
      : "動画に重ならないよう小さくします";
  };
  const scheduleLayout = () => {
    if (layoutFrame !== null) return;
    layoutFrame = requestAnimationFrame(() => {
      layoutFrame = null;
      applyLayout();
    });
  };
  const resizeObserver = new NativeResizeObserver(scheduleLayout);
  /** Watches the current player and preview iframe; Studio may replace either. */
  const observeLayoutTargets = () => {
    const player = studio.findPlayer();
    const iframe = studio.previewIframe();
    if (player === layoutTargets.player && iframe === layoutTargets.iframe) return;
    resizeObserver.disconnect();
    if (player !== null) resizeObserver.observe(player);
    if (iframe !== null) resizeObserver.observe(iframe);
    layoutTargets = { player, iframe };
  };
  cleanups.push(listen(window, "resize", scheduleLayout));

  // ---- Studio integration ----
  const translator = studio.createTranslator((node) => isOurs(node));
  const branding = studio.createBranding(BRAND);
  const onTimeUpdate = () => {
    const now = Date.now();
    if (now - lastFillAt < 250) return;
    lastFillAt = now;
    refreshFill();
  };
  const tick = () => {
    const logoFound = branding.refresh();
    const player = studio.findPlayer();
    if (player !== (observedPlayer?.player ?? null)) {
      observedPlayer?.remove();
      observedPlayer =
        player === null ? null : { player, remove: listen(player, "timeupdate", onTimeUpdate) };
    }
    broken.hidden = (logoFound && player !== null) || Date.now() - startedAt < BROKEN_AFTER_MS;
    hookComposition();
    observeLayoutTargets();
    // Pan, zoom and Studio's own layout changes do not resize the player.
    applyLayout();
    // Scenes are read from the composition DOM; every few seconds is enough.
    ticks += 1;
    if (ticks % SCENE_REFRESH_TICKS === 1) refreshScenes();
    refreshMarkers();
    refreshSpeeds();
    refreshFill();
    // An update whose state never came: send the local text again against the current revision.
    for (const [id, waiting] of awaiting) {
      if (Date.now() - waiting.at <= AWAIT_REVISION_MS) continue;
      awaiting.delete(id);
      const local = localText.get(id);
      if (local !== undefined && !scheduler.pending(id)) scheduler.change(id, local);
    }
    for (const [id, waiting] of placeAwaiting) {
      if (Date.now() - waiting.at > AWAIT_REVISION_MS) placeAwaiting.delete(id);
    }
    flushDeletes();
    // Unbound drafts switch to 「保存を確認中…」 with a manual retry; nothing is resent on its own.
    for (const placeholder of placeholders) {
      const view = views.get(placeholderKey(placeholder.requestId));
      if (view !== undefined) updateCard(view);
    }
    renderFooter();
  };

  const mount = () => {
    document.documentElement.append(host);
    translator.start();
    branding.start();
    render();
    tick();
    const interval = setInterval(tick, TICK_MS);
    cleanups.push(() => clearInterval(interval));
  };

  const unmount = () => {
    capture.cancel();
    resizeObserver.disconnect();
    if (layoutFrame !== null) cancelAnimationFrame(layoutFrame);
    scheduler.clear();
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    observedPlayer?.remove();
    observedPlayer = null;
    hooked?.remove();
    hooked = null;
    for (const cleanup of cleanups.splice(0)) cleanup();
    translator.stop();
    branding.stop();
    host.remove();
  };

  /** An event the panel shield stopped at the window; text input still reaches its card. */
  const onShielded = (event: Event) => {
    if (event.type !== "input" || !isTrustedEvent(event)) return;
    const active = shadow.activeElement;
    for (const view of views.values()) {
      if (view.text === active) {
        onTextInput(view);
        return;
      }
    }
  };

  return {
    host,
    onShielded,
    mount,
    unmount,
    setGeneration: (value: number) => {
      generation = value;
    },
    generation: () => generation,
    applyState,
    onRefused,
    captureBegin: (requestId: string) => void capture.begin(requestId),
    captureDone: (requestId: string, ok: boolean) => capture.done(requestId, ok),
  };
}

let session: Session | null = null;
/** Generation of an activation that arrived before the document had a body. */
let pendingGeneration: number | null = null;

// Installed when the preload loads, before Studio's scripts, so these window
// capture listeners run first. See `panelShield.ts`.
installPanelShield<Event>({
  listen: (type, handler) => {
    listen(window, type, handler, { capture: true });
  },
  composedPath,
  stopImmediatePropagation,
  host: () => session?.host ?? null,
  deliver: (event) => session?.onShielded(event),
});

const startPending = () => {
  if (pendingGeneration === null || session !== null || !document.body) return;
  session = createSession(pendingGeneration);
  pendingGeneration = null;
  session.mount();
};

const activate = (generation: number) => {
  if (session !== null) {
    session.setGeneration(generation);
    return;
  }
  const waiting = pendingGeneration !== null;
  pendingGeneration = generation;
  if (document.body) startPending();
  else if (!waiting) listen(document, "DOMContentLoaded", startPending, { once: true });
};

const deactivate = () => {
  pendingGeneration = null;
  session?.unmount();
  session = null;
};

const field = (payload: unknown, name: string): unknown =>
  typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)[name]
    : undefined;

ipcRenderer.on(CREATOR_ACTIVATE_CHANNEL, (_event, payload: unknown) => {
  const generation = field(payload, "generation");
  if (typeof generation === "number" && Number.isInteger(generation) && generation >= 0) {
    activate(generation);
  } else {
    deactivate();
  }
});
ipcRenderer.on(CREATOR_STATE_CHANNEL, (_event, payload: unknown) => {
  if (session === null || field(payload, "generation") !== session.generation()) return;
  const state = readPanelState(field(payload, "state"));
  if (state !== null) session.applyState(state);
});
ipcRenderer.on(CREATOR_CAPTURE_BEGIN_CHANNEL, (_event, payload: unknown) => {
  const requestId = field(payload, "requestId");
  if (session !== null && typeof requestId === "string") session.captureBegin(requestId);
});
ipcRenderer.on(CREATOR_CAPTURE_DONE_CHANNEL, (_event, payload: unknown) => {
  const requestId = field(payload, "requestId");
  if (session !== null && typeof requestId === "string") {
    session.captureDone(requestId, field(payload, "ok") === true);
  }
});
ipcRenderer.on(CREATOR_REFUSED_CHANNEL, (_event, payload: unknown) => {
  const kind = field(payload, "kind");
  const reason = field(payload, "reason");
  if (session !== null && typeof kind === "string") {
    session.onRefused(kind, typeof reason === "string" ? reason : "");
  }
});
