// @effect-diagnostics globalDate:off globalTimers:off globalRandom:off cryptoRandomUUID:off - Guest preload; runs outside any Effect runtime.
/**
 * Amu Creator overlay for HyperFrames Studio, loaded by the preview preload into
 * every guest. It does nothing until main sends `creator:activate` with a
 * generation, and removes itself (restoring the Studio DOM it changed) on
 * `creator:activate { generation: null }`.
 *
 * While active it translates Studio into Japanese, shows "Amu Creator" instead
 * of the HyperFrames logo, and adds the 修正コメント panel. The panel only
 * drafts, proposes and prepares captures; the server owns comment state and
 * the Amu window confirms every send. Buttons act only on trusted events, as a
 * guard against page scripts clicking them (not a security boundary).
 *
 * Messages to main (all `{ generation, payload }`, see `CreatorProtocol.ts`):
 * - draft `{ requestId, timeSec, comment, place: null }`, where `requestId` is
 *   the id of the capture-request sent when the placeholder card was made: the
 *   renderer attaches that request's shot to the comment the draft creates
 * - update `{ commentId, expectedRevision, comment }`
 * - place `{ commentId, expectedRevision, place }`, then a capture-request
 *   `{ purpose: "place", commentId, place }` centered on the point
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
  bindPlaceholders,
  commentActions,
  commentStatusLabel,
  formatTime,
  readPanelState,
  sendableIds,
  type PanelState,
} from "./panelState.ts";
import { sceneButtons } from "./sceneNames.ts";
import { createRateBudget, createUpdateScheduler, type UpdateScheduler } from "./sendPacer.ts";
import * as studio from "./studioDom.ts";

const BRAND = "Amu Creator";
const WAIT_NOTICE = "少し間をあけてください";
const BROKEN_NOTICE = "Amu Creator の一部が動いていません（HyperFrames の更新の影響）";
const CONFIRM_NOTE = "Amu の画面で送信を確定してください";
const TICK_MS = 1_000;
const SCENE_REFRESH_TICKS = 3;
const BROKEN_AFTER_MS = 5_000;
const DRAFT_SAVE_TIMEOUT_MS = 8_000;
const AWAIT_REVISION_MS = 3_000;
const REFUSAL_MATCH_MS = 2_000;
const DELETE_CONFIRM_MS = 3_000;
const SPEEDS = [1, 1.5, 2, 3] as const;

const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.panel { width: 340px; max-height: calc(100vh - 70px); display: flex; flex-direction: column;
  background: #121a26; color: #e7edf4; border: 2px solid #39d0b8; border-radius: 12px;
  font: 13px/1.5 system-ui, -apple-system, "Hiragino Sans", sans-serif;
  box-shadow: 0 0 22px rgba(57, 208, 184, .35); overflow: hidden; }
.tab { all: unset; cursor: pointer; padding: 8px 12px; font-weight: 800; display: flex;
  justify-content: space-between; border-bottom: 1px solid #2a3850; }
.body { overflow: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.collapsed .body, .collapsed .foot { display: none; }
.collapsed .tab { border-bottom: 0; }
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
    if (event.isTrusted) handler(event);
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
  /** commentId -> the revision an update or place was sent against, until a newer one arrives. */
  const awaiting = new Map<string, { revision: number; at: number }>();
  const lastSent = new Map<DesktopPreviewCreatorGuestKind, { key: string; at: number }>();
  let placing: { commentId: string; timeSec: number } | null = null;
  let justProposed = false;
  let collapsed = false;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFillAt = 0;
  let sceneSignature = "";
  let markerSignature = "";
  let observedPlayer: HTMLElement | null = null;
  let ticks = 0;
  const startedAt = Date.now();
  const cleanups: Array<() => void> = [];
  const hookedDocs = new WeakSet<Document>();
  const budget = createRateBudget();

  // ---- DOM ----
  const host = make("div");
  host.setAttribute("data-amu-creator", "");
  host.style.cssText = "position:fixed;top:56px;right:12px;z-index:2147483647";
  const shadow = host.attachShadow({ mode: "closed" });
  const style = make("style");
  style.textContent = PANEL_CSS;
  const panel = make("div", "panel");
  const tab = make("button", "tab");
  const tabLabel = make("span");
  const tabArrow = make("span", undefined, "▾");
  tab.append(tabLabel, tabArrow);
  const body = make("div", "body");
  const broken = make("div", "banner warn", BROKEN_NOTICE);
  broken.hidden = true;
  const notice = make("div", "banner info");
  notice.hidden = true;
  const big = make("button", "big", "▶ いま止めた位置にコメント");
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
    button.addEventListener(
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
  panel.append(tab, body, foot);
  shadow.append(style, panel);

  const isOurs = (node: Node | null): boolean =>
    node !== null && (node === host || host.contains(node));
  const fromPanel = (event: Event): boolean => event.composedPath().includes(host);
  const focusedInPanel = (): Element | null => shadow.activeElement;

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

  const scheduler: UpdateScheduler = createUpdateScheduler({
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    send: (key, value) => {
      const text = value.trim();
      const placeholder = placeholderOf(key);
      if (placeholder !== undefined) {
        // Saving: further typing waits until the card is bound to its comment.
        if (placeholder.sentText !== null) return false;
        if (text === "") return true;
        const ok = send(
          "draft",
          key,
          {
            requestId: placeholder.requestId,
            timeSec: placeholder.timeSec,
            comment: text,
            place: null,
          },
          { quiet: true },
        );
        if (ok) {
          placeholder.sentText = text;
          placeholder.sentAt = Date.now();
          renderCards();
        }
        return ok;
      }
      const comment = commentById(key);
      if (comment === undefined || text === "" || text === comment.comment) return true;
      if (comment.status === "sending") return false;
      const waiting = awaiting.get(key);
      if (waiting !== undefined && Date.now() - waiting.at < AWAIT_REVISION_MS) return false;
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
    scheduler.pending(key) || awaiting.has(key) || placeholderOf(key) !== undefined;

  // ---- capture ----
  const measure = (spec: CaptureSpec) => {
    const comp = studio.compositionRect();
    if (comp === null) return null;
    if (spec.pin === null) return { rect: comp };
    const rect = pinCropRect(comp, spec.pin.x, spec.pin.y, {
      width: comp.width / 2,
      height: comp.height / 2,
    });
    return {
      rect,
      pin: { x: comp.x + spec.pin.x * comp.width, y: comp.y + spec.pin.y * comp.height },
    };
  };
  let restoreFocus: Element | null = null;
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
    hide: () => {
      restoreFocus = focusedInPanel();
      host.style.opacity = "0";
      host.style.pointerEvents = "none";
    },
    show: () => {
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
    onSettled: (spec, ok) => {
      const key = spec.purpose === "draft" ? viewKeyForRequest(spec.requestId) : spec.commentId;
      const view = key === null ? undefined : views.get(key);
      if (view !== undefined) view.capture = ok ? "ok" : "failed";
      render();
    },
  });
  /** Placeholder key, or the comment the placeholder became. */
  const boundRequests = new Map<string, string>();
  const viewKeyForRequest = (requestId: string): string =>
    boundRequests.get(requestId) ?? placeholderKey(requestId);

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
    placeholders.unshift({ requestId, timeSec, sentText: null, sentAt: 0 });
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
    if (placing === null || !event.isTrusted || capture.busy()) return false;
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
    if (
      send("place", comment.id, {
        commentId: comment.id,
        expectedRevision: comment.revision,
        place,
      })
    ) {
      awaiting.set(comment.id, { revision: comment.revision, at: Date.now() });
      const view = views.get(comment.id);
      if (view !== undefined) view.capture = "pending";
      capture.request({
        requestId: newRequestId(),
        purpose: "place",
        timeSec: target.timeSec,
        commentId: comment.id,
        place,
        pin: point,
      });
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
      placeholders.splice(placeholders.indexOf(placeholder), 1);
      scheduler.cancel(view.key);
      render();
      return;
    }
    if (send("delete", view.key, { commentId: view.key })) scheduler.cancel(view.key);
  };

  const propose = (commentIds: string[]) => {
    if (commentIds.length === 0) return;
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
    const sendOne = make("button", "mini", "これだけ送る");
    const remove = make("button", "mini", "削除");
    const cancel = make("button", "mini", "取り消し");
    const confirm = make("button", "mini", "確認済みにする");
    actions.append(cancel, confirm, sendOne, remove);
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
      sendOne,
      remove,
      cancel,
      confirm,
      capture: null,
      deleteArmedAt: 0,
    };
    time.addEventListener(
      "click",
      trusted(() => {
        if (capture.frozen()) return;
        const timeSec = commentById(view.key)?.timeSec ?? placeholderOf(view.key)?.timeSec;
        if (timeSec === undefined) return;
        studio.pausePlayer();
        studio.seekTo(timeSec);
      }),
    );
    text.addEventListener(
      "input",
      trusted(() => {
        scheduler.change(view.key, text.value);
        updateCard(view);
      }),
    );
    text.addEventListener("blur", () => scheduler.flush(view.key));
    placeButton.addEventListener(
      "click",
      trusted(() => startPlacing(view.key)),
    );
    sendOne.addEventListener(
      "click",
      trusted(() => propose([view.key])),
    );
    remove.addEventListener(
      "click",
      trusted(() => removeCard(view)),
    );
    cancel.addEventListener(
      "click",
      trusted(() => {
        const comment = commentById(view.key);
        const proposalId =
          comment && state ? commentActions(comment, state.proposals).cancelProposalId : null;
        if (proposalId !== null) send("cancel", proposalId, { proposalId });
      }),
    );
    confirm.addEventListener(
      "click",
      trusted(() => send("confirm-by-user", view.key, { commentId: view.key })),
    );
    return view;
  };

  const updateCard = (view: CardView) => {
    const placeholder = placeholderOf(view.key);
    const comment = commentById(view.key);
    const armed = Date.now() - view.deleteArmedAt <= DELETE_CONFIRM_MS;
    view.remove.textContent = armed ? "本当に削除する" : "削除";
    view.shot.textContent =
      view.capture === "pending"
        ? "撮影中…"
        : view.capture === "failed" || (view.capture === null && comment?.shot === null)
          ? "画像なし"
          : "";
    if (placeholder !== undefined) {
      view.time.textContent = formatTime(placeholder.timeSec);
      view.status.textContent = placeholder.sentText === null ? "未保存" : "保存中…";
      view.placeText.textContent = "";
      view.placeButton.textContent = "＋ 場所も指定する（任意）";
      view.placeButton.disabled = true;
      view.placeButton.title = "先に指示を書いてください";
      view.ai.hidden = true;
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
    if (!dirty && focusedInPanel() !== view.text && view.text.value !== comment.comment) {
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
    view.sendOne.hidden = !actions.sendOne;
    view.sendOne.disabled = dirty;
    view.sendOne.title = dirty ? "保存が終わるまでお待ちください" : "";
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
    for (const placeholder of placeholders)
      open.push(viewFor(placeholderKey(placeholder.requestId)));
    const comments = [...(state?.comments ?? [])].toSorted((a, b) => b.number - a.number);
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
    const dirty = ids.some(isDirty);
    sendAll.textContent = dirty ? "保存中…" : `まとめて送る（${ids.length} 件）`;
    sendAll.disabled = ids.length === 0 || dirty;
    const proposed = state?.comments.some((comment) => comment.status === "proposed") ?? false;
    confirmNote.hidden = !(justProposed || proposed);
    big.disabled = capture.busy();
    big.textContent = capture.busy() ? "撮影中…" : "▶ いま止めた位置にコメント";
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
      mark.addEventListener(
        "click",
        trusted((event) => {
          event.stopPropagation();
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
      button.addEventListener(
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
      scheduler.rekey(key, commentId);
      if (view !== undefined) {
        views.delete(key);
        view.key = commentId;
        views.set(commentId, view);
        // Typed after the draft went out: send the rest as an update.
        if (placeholder?.sentText !== view.text.value.trim() && !scheduler.pending(commentId)) {
          scheduler.change(commentId, view.text.value);
        }
      }
    }
    for (const [id, waiting] of awaiting) {
      const comment = next.comments.find((entry) => entry.id === id);
      if (comment === undefined || comment.revision > waiting.revision) awaiting.delete(id);
    }
    state = next;
    for (const comment of next.comments) knownIds.add(comment.id);
    justProposed = false;
    if (next.notice !== null) showNotice(next.notice);
    render();
  };

  const onRefused = (kind: string) => {
    showNotice(WAIT_NOTICE);
    const sent = lastSent.get(kind as DesktopPreviewCreatorGuestKind);
    if (sent === undefined || Date.now() - sent.at > REFUSAL_MATCH_MS) return;
    if (kind === "draft") {
      const placeholder = placeholderOf(sent.key);
      const view = views.get(sent.key);
      if (placeholder !== undefined && view !== undefined) {
        placeholder.sentText = null;
        scheduler.change(sent.key, view.text.value);
      }
    } else if (kind === "update" || kind === "place") {
      awaiting.delete(sent.key);
      const view = views.get(sent.key);
      if (kind === "update" && view !== undefined) scheduler.change(sent.key, view.text.value);
    }
    render();
  };

  // ---- input guards ----
  const swallow = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
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
  const listen = (target: EventTarget, type: string, handler: (event: Event) => void) => {
    target.addEventListener(type, handler, { capture: true, passive: false });
    cleanups.push(() => target.removeEventListener(type, handler, { capture: true }));
  };
  for (const type of POINTER_EVENTS) {
    listen(window, type, (event) => {
      const mouse = event as MouseEvent;
      guardPointer(mouse, mouse.clientX, mouse.clientY);
    });
  }
  for (const type of FROZEN_EVENTS) {
    listen(window, type, (event) => {
      if (capture.frozen() && !fromPanel(event)) swallow(event);
    });
  }
  for (const type of KEY_EVENTS) listen(window, type, (event) => guardKey(event as KeyboardEvent));
  /** The preview iframe gets its own listeners; its events never reach this window. */
  const hookComposition = () => {
    const doc = studio.compositionDocument();
    if (doc === null || hookedDocs.has(doc)) return;
    hookedDocs.add(doc);
    for (const type of POINTER_EVENTS) {
      listen(doc, type, (event) => {
        const mouse = event as MouseEvent;
        const point = studio.iframePointToViewport(mouse.clientX, mouse.clientY);
        if (point !== null) guardPointer(mouse, point.x, point.y);
      });
    }
    for (const type of [...FROZEN_EVENTS, ...KEY_EVENTS]) {
      listen(doc, type, (event) => {
        if (capture.frozen()) swallow(event);
      });
    }
  };
  // Keys typed in the panel stay out of Studio's shortcuts; clicks do not deselect in Studio.
  for (const type of [...KEY_EVENTS, "pointerdown", "mousedown", "click"]) {
    panel.addEventListener(type, (event) => event.stopPropagation());
  }
  tab.addEventListener(
    "click",
    trusted(() => {
      collapsed = !collapsed;
      panel.classList.toggle("collapsed", collapsed);
      tabArrow.textContent = collapsed ? "▸" : "▾";
    }),
  );
  big.addEventListener("click", trusted(commentHere));
  sendAll.addEventListener(
    "click",
    trusted(() => propose(state === null ? [] : sendableIds(state.comments))),
  );
  track.addEventListener(
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
    if (player !== observedPlayer) {
      observedPlayer?.removeEventListener("timeupdate", onTimeUpdate);
      player?.addEventListener("timeupdate", onTimeUpdate);
      observedPlayer = player;
    }
    broken.hidden = (logoFound && player !== null) || Date.now() - startedAt < BROKEN_AFTER_MS;
    hookComposition();
    // Scenes are read from the composition DOM; every few seconds is enough.
    ticks += 1;
    if (ticks % SCENE_REFRESH_TICKS === 1) refreshScenes();
    refreshMarkers();
    refreshSpeeds();
    refreshFill();
    // An edit the server never applied (refused, or the state never came) is sent again.
    for (const [id, waiting] of awaiting) {
      if (Date.now() - waiting.at <= AWAIT_REVISION_MS) continue;
      awaiting.delete(id);
      const view = views.get(id);
      const comment = commentById(id);
      const text = view?.text.value.trim() ?? "";
      if (view !== undefined && comment !== undefined && text !== "" && text !== comment.comment) {
        scheduler.change(id, view.text.value);
      }
    }
    // A draft that never came back from the server is sent again.
    for (const placeholder of placeholders) {
      if (
        placeholder.sentText !== null &&
        Date.now() - placeholder.sentAt > DRAFT_SAVE_TIMEOUT_MS
      ) {
        const key = placeholderKey(placeholder.requestId);
        placeholder.sentText = null;
        const view = views.get(key);
        if (view !== undefined) scheduler.change(key, view.text.value);
        showNotice("保存できませんでした。もう一度試します");
      }
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
    scheduler.clear();
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    observedPlayer?.removeEventListener("timeupdate", onTimeUpdate);
    for (const cleanup of cleanups.splice(0)) cleanup();
    translator.stop();
    branding.stop();
    host.remove();
  };

  return {
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
  else if (!waiting) document.addEventListener("DOMContentLoaded", startPending, { once: true });
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
  if (session !== null && typeof kind === "string") session.onRefused(kind);
});
