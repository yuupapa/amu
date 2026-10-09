// @effect-diagnostics globalTimers:off - Throwaway stage-0 spike preload; runs outside any Effect runtime.
import { ipcRenderer } from "electron";

import { normalizePoint, pinCropRect, toPageRect, type Rect } from "./creatorSpikeGeometry.ts";
import {
  CREATOR_SPIKE_ACTIVATE,
  CREATOR_SPIKE_DRAFT,
  CREATOR_SPIKE_LOCATE,
  CREATOR_SPIKE_PROPOSE,
  CREATOR_SPIKE_STATE,
  CREATOR_SPIKE_UPDATE,
} from "./CreatorSpikeProtocol.ts";

type SpikePin = {
  id: string;
  number: number;
  timeSec: number;
  x: number | null;
  y: number | null;
  compositionFile: string | null;
  elementSelector: string | null;
  comment: string;
  status: string;
  shotPath: string | null;
};
type Player = HTMLElement & {
  currentTime?: number;
  duration?: number;
  playbackRate?: number;
  pause?: () => void;
  seek?: (t: number) => void;
};

let generation = 0;
let pins: SpikePin[] = [];
let placingFor: string | null = null;
let focusNumber: number | null = null;
let speed = 1;
let lastTimeSource = "none";
let capturingNote = false;

const player = (): Player | null => document.querySelector<Player>("hyperframes-player");
// Studio renders the composition inside <hyperframes-player>'s shadow root.
const previewIframe = (): HTMLIFrameElement | null =>
  player()?.shadowRoot?.querySelector<HTMLIFrameElement>("iframe") ?? null;

const probeTime = (): number | null => {
  const fromPlayer = player()?.currentTime;
  if (typeof fromPlayer === "number" && Number.isFinite(fromPlayer)) {
    lastTimeSource = "player.currentTime";
    return fromPlayer;
  }
  const w = previewIframe()?.contentWindow as (Window & Record<string, unknown>) | null | undefined;
  const timelines = w?.["__timelines"] as Record<string, { time?: () => number }> | undefined;
  const main = timelines?.["main"]?.time?.();
  if (typeof main === "number" && Number.isFinite(main)) {
    lastTimeSource = "__timelines.main";
    return main;
  }
  return null;
};

const compRectInPage = (): Rect | null => {
  const iframe = previewIframe();
  const root = iframe?.contentDocument?.querySelector<HTMLElement>("[data-composition-id]");
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

/** Scene hosts in the assembled preview, with a short readable label. */
const scenes = (): Array<{ label: string; start: number }> => {
  const doc = previewIframe()?.contentDocument;
  if (!doc) return [];
  return [...doc.querySelectorAll<HTMLElement>("[data-composition-file]")]
    .map((host) => {
      const start = Number(host.getAttribute("data-start") ?? "0");
      const heading = [...host.querySelectorAll<HTMLElement>("*")]
        .map((node) => (node.childElementCount === 0 ? (node.textContent ?? "").trim() : ""))
        .find((text) => /[ぁ-んァ-ン一-龥]/.test(text) && text.length >= 2 && text.length <= 10);
      return { label: heading ?? host.id, start };
    })
    .sort((a, b) => a.start - b.start);
};

const fmt = (t: number) =>
  `${Math.floor(t / 60)}分${String(Math.floor(t % 60)).padStart(2, "0")}秒`;
const nextFrames = (n: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
    step(n);
  });
const make = <K extends keyof HTMLElementTagNameMap>(tag: K, css: string, text?: string) => {
  const node = document.createElement(tag);
  node.style.cssText = css;
  if (text !== undefined) node.textContent = text;
  return node;
};

const panel = make(
  "div",
  "position:fixed;top:56px;right:12px;z-index:2147483647;width:340px;max-height:calc(100vh - 70px);overflow:auto;background:#121a26;color:#e7edf4;border:2px solid #39d0b8;border-radius:12px;padding:12px;font:13px/1.5 system-ui;box-shadow:0 0 22px rgba(57,208,184,.35);display:none",
);
panel.setAttribute("data-amu-creator-spike", "");
const chip =
  "border:1px solid #33435c;border-radius:6px;padding:3px 9px;background:#18233a;color:#e7edf4;font-size:12px;cursor:pointer";
const mini =
  "border:1px solid #33435c;border-radius:5px;padding:1px 8px;background:transparent;color:#c8d3df;font-size:11px;cursor:pointer";

const commentHere = async () => {
  player()?.pause?.();
  await nextFrames(2);
  const timeSec = probeTime();
  const comp = compRectInPage();
  if (timeSec === null || !comp) return;
  panel.style.visibility = "hidden";
  await nextFrames(1);
  ipcRenderer.send(
    CREATOR_SPIKE_DRAFT,
    generation,
    { timeSec, x: null, y: null, compositionFile: null, elementSelector: null, comment: "" },
    comp,
  );
  focusNumber = (pins.at(-1)?.number ?? 0) + 1;
  capturingNote = true;
  setTimeout(() => {
    panel.style.visibility = "visible";
  }, 300);
};

const render = () => {
  const keepScroll = panel.scrollTop;
  panel.innerHTML = "";
  panel.append(make("div", "font-weight:800;margin-bottom:8px", `修正コメント（${pins.length}）`));
  const big = make(
    "button",
    "width:100%;background:#f2f5f8;color:#121a26;border:0;border-radius:8px;padding:10px;font-weight:800;font-size:14px;cursor:pointer",
    "▶ いま止めた位置にコメント",
  );
  big.onclick = () => void commentHere();
  panel.append(big);
  if (capturingNote) {
    panel.append(
      make(
        "div",
        "margin-top:8px;padding:6px 8px;border-radius:6px;background:#1d3346;color:#9fd7ff;font-size:12px",
        `${fmt(probeTime() ?? 0)} の画面を撮影中…（このあと入力欄が開きます）`,
      ),
    );
  }
  if (placingFor) {
    panel.append(
      make(
        "div",
        "margin-top:8px;padding:6px 8px;border-radius:6px;background:#3a2f12;color:#f3cf7a;font-size:12px",
        "プレビューの直したい場所を 1 回クリックしてください",
      ),
    );
  }

  for (const p of [...pins].reverse()) {
    const card = make(
      "div",
      "background:#18233a;border-radius:8px;padding:8px;margin-top:8px;display:flex;flex-direction:column;gap:6px",
    );
    const head = make("div", "display:flex;gap:6px;align-items:center");
    const time = make(
      "button",
      "background:#203250;color:#7cc4ff;border:0;border-radius:5px;padding:1px 7px;font-weight:700;cursor:pointer",
      fmt(p.timeSec),
    );
    time.onclick = () => {
      player()?.pause?.();
      player()?.seek?.(p.timeSec);
    };
    const status =
      ({ draft: "未送信", proposed: "確認待ち", sent: "送信済み" } as Record<string, string>)[
        p.status
      ] ?? p.status;
    head.append(
      time,
      make("span", "font-size:11px;color:#9fb0c4", `${status}${p.shotPath ? "" : "・画像なし"}`),
    );
    const input = make(
      "textarea",
      "width:100%;box-sizing:border-box;background:#0f1622;color:#e7edf4;border:1px solid #33435c;border-radius:6px;padding:6px;font:13px system-ui;resize:vertical",
    );
    input.rows = 2;
    input.value = p.comment;
    input.placeholder = "直してほしいことを書く";
    input.onchange = () => ipcRenderer.send(CREATOR_SPIKE_UPDATE, generation, p.id, input.value);
    const place = make("div", "display:flex;gap:6px;align-items:center;flex-wrap:wrap");
    if (p.x !== null) {
      place.append(
        make(
          "span",
          mini + ";cursor:default",
          `📍 場所：${p.elementSelector ?? p.compositionFile ?? "指定済み"}`,
        ),
      );
    } else {
      const add = make(
        "button",
        mini,
        placingFor === p.id ? "クリック待ち…（取り消す）" : "＋ 場所も指定する（任意）",
      );
      add.onclick = () => {
        placingFor = placingFor === p.id ? null : p.id;
        render();
      };
      place.append(add);
    }
    const acts = make("div", "display:flex;gap:6px;justify-content:flex-end");
    const one = make("button", mini, "これだけ送る");
    one.disabled = p.status !== "draft";
    one.onclick = () => ipcRenderer.send(CREATOR_SPIKE_PROPOSE, generation, [p.id]);
    acts.append(one);
    card.append(head, input, place, acts);
    panel.append(card);
    if (focusNumber === p.number) {
      focusNumber = null;
      // The panel is hidden while the frame is captured; focus once it is back.
      const focusWhenVisible = () =>
        panel.style.visibility === "hidden" ? setTimeout(focusWhenVisible, 50) : input.focus();
      setTimeout(focusWhenVisible, 0);
    }
  }

  const drafts = pins.filter((p) => p.status === "draft");
  const send = make(
    "button",
    "width:100%;margin-top:10px;background:#2f6f5e;color:#fff;border:0;border-radius:8px;padding:9px;font-weight:800;cursor:pointer",
    `まとめて送る（${drafts.length}件）`,
  );
  send.disabled = drafts.length === 0;
  send.onclick = () =>
    ipcRenderer.send(
      CREATOR_SPIKE_PROPOSE,
      generation,
      drafts.map((p) => p.id),
    );
  panel.append(send);

  // Review tools: seek bar with comment marks, speed, jump to scene.
  const duration = player()?.duration ?? 0;
  const tools = make(
    "div",
    "margin-top:12px;border-top:1px solid #2a3850;padding-top:10px;display:flex;flex-direction:column;gap:8px",
  );
  const track = make(
    "div",
    "position:relative;height:8px;border-radius:4px;background:#2a3850;cursor:pointer",
  );
  const now = probeTime() ?? 0;
  if (duration > 0) {
    track.append(
      make(
        "div",
        `position:absolute;left:0;top:0;bottom:0;width:${(now / duration) * 100}%;background:#e2b25a;border-radius:4px`,
      ),
    );
    for (const p of pins) {
      track.append(
        make(
          "span",
          `position:absolute;top:-4px;left:${(p.timeSec / duration) * 100}%;width:4px;height:16px;background:#39d0b8;border-radius:2px`,
        ),
      );
    }
  }
  track.onclick = (e) => {
    const r = track.getBoundingClientRect();
    if (duration > 0) player()?.seek?.(((e.clientX - r.x) / r.width) * duration);
  };
  const speeds = make(
    "div",
    "display:flex;gap:5px;align-items:center;font-size:12px;color:#9fb0c4",
    "倍速 ",
  );
  for (const v of [1, 1.5, 2, 3]) {
    const b = make(
      "button",
      chip + (speed === v ? ";border-color:#e2b25a;color:#e2b25a" : ""),
      `${v}x`,
    );
    b.onclick = () => {
      speed = v;
      const p = player();
      if (p) p.playbackRate = v;
      render();
    };
    speeds.append(b);
  }
  const jumps = make(
    "div",
    "display:flex;gap:5px;align-items:center;flex-wrap:wrap;font-size:12px;color:#9fb0c4",
    "場面へ移動 ",
  );
  for (const s of scenes()) {
    const b = make("button", chip, s.label);
    b.onclick = () => {
      player()?.pause?.();
      player()?.seek?.(s.start + 0.5);
    };
    jumps.append(b);
  }
  tools.append(track, speeds, jumps);
  panel.append(tools);
  panel.scrollTop = keepScroll;
};

// While waiting for a place click, Studio must not see the press (it selects on
// pointerdown and re-lays out before the capture).
const swallowOverComposition = (e: MouseEvent) => {
  if (!placingFor || panel.contains(e.target as Node)) return;
  const comp = compRectInPage();
  if (comp && normalizePoint(comp, e.clientX, e.clientY)) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
};
for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick"]) {
  window.addEventListener(type, swallowOverComposition as EventListener, true);
}

const placeAt = async (event: MouseEvent, pageX: number, pageY: number) => {
  if (!placingFor || panel.contains(event.target as Node)) return;
  const comp = compRectInPage();
  if (!comp) return;
  const point = normalizePoint(comp, pageX, pageY);
  if (!point) return;
  event.preventDefault();
  event.stopPropagation();
  const pinId = placingFor;
  placingFor = null;
  const { compositionFile, elementSelector } = elementAt(point.x, point.y);
  panel.style.visibility = "hidden";
  await nextFrames(1);
  const crop = pinCropRect(comp, point.x, point.y, {
    width: comp.width / 2,
    height: comp.height / 2,
  });
  ipcRenderer.send(
    CREATOR_SPIKE_LOCATE,
    generation,
    pinId,
    { x: point.x, y: point.y, compositionFile, elementSelector },
    crop,
  );
  setTimeout(() => {
    panel.style.visibility = "visible";
  }, 300);
};
window.addEventListener("click", (e) => void placeAt(e, e.clientX, e.clientY), true);
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
      void placeAt(e, ir.x + e.clientX * sx, ir.y + e.clientY * sy);
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
  // Keep the seek bar honest while the video plays; never redraw under the user's typing.
  setInterval(() => {
    if (!panel.contains(document.activeElement)) render();
  }, 1000);
});
ipcRenderer.on(CREATOR_SPIKE_STATE, (_e, payload: { generation: number; pins: SpikePin[] }) => {
  pins = payload.pins;
  capturingNote = false;
  if (!panel.contains(document.activeElement) || focusNumber !== null) render();
});

(window as unknown as Record<string, unknown>)["__amuCreatorSpike"] = {
  probeTime,
  timeSource: () => lastTimeSource,
  generation: () => generation,
};
