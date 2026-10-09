// @effect-diagnostics globalTimers:off - Throwaway stage-0 spike preload; runs outside any Effect runtime.
import { ipcRenderer } from "electron";

import { normalizePoint, pinCropRect, toPageRect, type Rect } from "./creatorSpikeGeometry.ts";
import {
  CREATOR_SPIKE_ACTIVATE,
  CREATOR_SPIKE_DRAFT,
  CREATOR_SPIKE_PROPOSE,
  CREATOR_SPIKE_STATE,
  CREATOR_SPIKE_UPDATE,
} from "./CreatorSpikeProtocol.ts";

type SpikePin = {
  id: string;
  number: number;
  timeSec: number;
  comment: string;
  status: string;
  shotPath: string | null;
};
let generation = 0;
let pinMode = false;
let pins: SpikePin[] = [];

type Player = HTMLElement & { currentTime?: number; pause?: () => void };
const player = (): Player | null => document.querySelector<Player>("hyperframes-player");
// Studio renders the composition inside <hyperframes-player>'s shadow root.
const previewIframe = (): HTMLIFrameElement | null =>
  player()?.shadowRoot?.querySelector<HTMLIFrameElement>("iframe") ?? null;

/** Tries each candidate in order; Task 5 records which one answered. */
let lastTimeSource = "none";
const probeTime = (): number | null => {
  const fromPlayer = player()?.currentTime;
  if (typeof fromPlayer === "number" && Number.isFinite(fromPlayer)) {
    lastTimeSource = "player.currentTime";
    return fromPlayer;
  }
  const w = previewIframe()?.contentWindow as (Window & Record<string, unknown>) | null | undefined;
  if (!w) return null;
  lastTimeSource = "__timelines.main";
  const timelines = w["__timelines"] as Record<string, { time?: () => number }> | undefined;
  const main = timelines?.["main"]?.time?.();
  if (typeof main === "number" && Number.isFinite(main)) return main;
  const hash = new URLSearchParams(location.hash.split("?")[1] ?? "").get("t");
  return hash !== null && Number.isFinite(Number(hash)) ? Number(hash) : null;
};

const compRectInPage = (): Rect | null => {
  const iframe = previewIframe();
  const doc = iframe?.contentDocument;
  const root = doc?.querySelector<HTMLElement>("[data-composition-id]");
  if (!iframe || !root) return null;
  const ir = iframe.getBoundingClientRect();
  const rr = root.getBoundingClientRect();
  return toPageRect({
    compInIframe: { x: rr.x, y: rr.y, width: rr.width, height: rr.height },
    iframeInPage: { x: ir.x, y: ir.y, width: ir.width, height: ir.height },
    iframeScaleX: ir.width / iframe.clientWidth || 1,
    iframeScaleY: ir.height / iframe.clientHeight || 1,
  });
};

const elementAt = (nx: number, ny: number) => {
  const doc = previewIframe()?.contentDocument;
  const root = doc?.querySelector<HTMLElement>("[data-composition-id]");
  if (!doc || !root) return { compositionFile: null, elementSelector: null };
  const r = root.getBoundingClientRect();
  let el = doc.elementFromPoint(r.x + nx * r.width, r.y + ny * r.height) as HTMLElement | null;
  while (el && !el.id) el = el.parentElement;
  // The assembled preview keeps the source file on the scene host as data-composition-file.
  const host = el?.closest<HTMLElement>("[data-composition-file]");
  return {
    compositionFile: host?.getAttribute("data-composition-file")?.slice(0, 200) ?? null,
    elementSelector: el?.id ? `#${el.id}`.slice(0, 200) : null,
  };
};

const pausePlayback = () => {
  player()?.pause?.();
};
const nextFrames = (n: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
    step(n);
  });

const panel = document.createElement("div");
panel.setAttribute("data-amu-creator-spike", "");
panel.style.cssText =
  "position:fixed;top:64px;right:16px;z-index:2147483647;width:300px;max-height:60vh;overflow:auto;background:#fff;color:#1d2430;border:2px solid #e2b25a;border-radius:10px;padding:10px;font:13px/1.5 system-ui;box-shadow:0 8px 24px rgba(0,0,0,.25);display:none";

const render = () => {
  panel.innerHTML = "";
  const toggle = document.createElement("button");
  toggle.textContent = pinMode ? "📍 修正ピン：オン" : "📍 修正ピン：オフ";
  toggle.onclick = () => {
    pinMode = !pinMode;
    render();
  };
  const send = document.createElement("button");
  const drafts = pins.filter((p) => p.status === "draft");
  send.textContent = `まとめて送る（${drafts.length}）`;
  send.disabled = drafts.length === 0;
  send.onclick = () =>
    ipcRenderer.send(
      CREATOR_SPIKE_PROPOSE,
      generation,
      drafts.map((p) => p.id),
    );
  panel.append(toggle, " ", send);
  for (const p of pins) {
    const row = document.createElement("div");
    row.style.cssText = "border-top:1px dashed #ddd;margin-top:6px;padding-top:6px";
    const input = document.createElement("textarea");
    input.value = p.comment;
    input.rows = 2;
    input.style.width = "100%";
    input.placeholder = "指示（fn を 2 回押すと声で入力できます）";
    input.onchange = () => ipcRenderer.send(CREATOR_SPIKE_UPDATE, generation, p.id, input.value);
    const one = document.createElement("button");
    one.textContent = "これだけ送る";
    one.disabled = p.status !== "draft";
    one.onclick = () => ipcRenderer.send(CREATOR_SPIKE_PROPOSE, generation, [p.id]);
    row.append(
      `#${p.number} ${p.timeSec.toFixed(1)}s [${p.status}]${p.shotPath ? "" : " 画像なし"}`,
      input,
      one,
    );
    panel.append(row);
  }
};

/** `pageX`/`pageY` are viewport coordinates of the top document. */
const placePin = async (event: MouseEvent, pageX: number, pageY: number) => {
  if (!pinMode || panel.contains(event.target as Node)) return;
  const comp = compRectInPage();
  if (!comp) return;
  const point = normalizePoint(comp, pageX, pageY);
  if (!point) return;
  event.preventDefault();
  event.stopPropagation();
  pausePlayback();
  await nextFrames(2);
  const timeSec = probeTime();
  if (timeSec === null) return;
  const { compositionFile, elementSelector } = elementAt(point.x, point.y);
  panel.style.visibility = "hidden";
  await nextFrames(1);
  const crop = pinCropRect(comp, point.x, point.y, {
    width: comp.width / 2,
    height: comp.height / 2,
  });
  ipcRenderer.send(
    CREATOR_SPIKE_DRAFT,
    generation,
    { timeSec, x: point.x, y: point.y, compositionFile, elementSelector, comment: "" },
    crop,
  );
  setTimeout(() => {
    panel.style.visibility = "visible";
  }, 300);
};

// Studio selects elements on pointerdown, so in pin mode swallow the whole
// press sequence over the composition before Studio sees it.
const swallowOverComposition = (e: MouseEvent) => {
  if (!pinMode || panel.contains(e.target as Node)) return;
  const comp = compRectInPage();
  if (comp && normalizePoint(comp, e.clientX, e.clientY)) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
};
for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick"]) {
  window.addEventListener(type, swallowOverComposition as EventListener, true);
}
// Studio may put its own canvas layer above the iframe (clicks land in the top
// document) or let clicks reach the iframe (they land in the iframe document).
window.addEventListener("click", (e) => void placePin(e, e.clientX, e.clientY), true);
const hookIframe = () => {
  const iframe = previewIframe();
  const doc = iframe?.contentDocument as (Document & Record<string, unknown>) | null | undefined;
  if (!iframe || !doc || doc["__amuSpikeHooked"]) return;
  doc["__amuSpikeHooked"] = true;
  doc.addEventListener(
    "click",
    (e) => {
      const ir = iframe.getBoundingClientRect();
      const sx = ir.width / iframe.clientWidth || 1;
      const sy = ir.height / iframe.clientHeight || 1;
      void placePin(e, ir.x + e.clientX * sx, ir.y + e.clientY * sy);
    },
    true,
  );
};

ipcRenderer.on(CREATOR_SPIKE_ACTIVATE, (_e, payload: { generation: number }) => {
  generation = payload.generation;
  if (!panel.isConnected) document.documentElement.append(panel);
  panel.style.display = "block";
  render();
  setInterval(hookIframe, 1000);
});
ipcRenderer.on(CREATOR_SPIKE_STATE, (_e, payload: { generation: number; pins: SpikePin[] }) => {
  pins = payload.pins;
  render();
});

(window as unknown as Record<string, unknown>)["__amuCreatorSpike"] = {
  probeTime,
  timeSource: () => lastTimeSource,
  generation: () => generation,
};
