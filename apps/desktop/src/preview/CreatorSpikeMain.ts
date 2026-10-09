// @effect-diagnostics globalDate:off nodeBuiltinImport:off - Throwaway stage-0 spike, gated by AMU_CREATOR_SPIKE=1.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { BrowserWindow, type IpcMainEvent, type WebContents } from "electron";

import { SPIKE_LIMITS, clampToViewport, isUsableRect } from "./creatorSpikeGeometry.ts";
import {
  CREATOR_SPIKE_ACTIVATE,
  CREATOR_SPIKE_DRAFT,
  CREATOR_SPIKE_LOCATE,
  CREATOR_SPIKE_PROPOSE,
  CREATOR_SPIKE_STATE,
  CREATOR_SPIKE_UPDATE,
  creatorSpikeEnabled,
} from "./CreatorSpikeProtocol.ts";
import { createSpikeState } from "./creatorSpikeState.ts";

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Trusted confirmation owned by Amu's main process, outside the guest page.
 * The stage-0 spike uses a small window instead of a native alert so it can be
 * driven over CDP; the real feature shows this inside Amu's renderer.
 */
const confirmInAmuWindow = (
  snapshot: ReadonlyArray<{
    number: number;
    timeSec: number;
    comment: string;
    shotPath: string | null;
  }>,
): Promise<"send" | "cancel"> =>
  new Promise((resolve) => {
    const rows = snapshot
      .map((p) => {
        const img = p.shotPath
          ? `<img src="data:image/png;base64,${readFileSync(p.shotPath).toString("base64")}">`
          : "<div class=noimg>画像なし</div>";
        return `<li><b>#${p.number}</b> ${p.timeSec.toFixed(1)}秒<p>${escapeHtml(p.comment) || "（指示なし）"}</p>${img}</li>`;
      })
      .join("");
    const html = `<!doctype html><meta charset=utf-8><title>Amu Creator 送信確認</title><style>body{font:14px system-ui;margin:16px}ul{padding:0;list-style:none}li{border-top:1px solid #ddd;padding:8px 0}img{max-width:100%;border-radius:6px}button{font-size:14px;padding:6px 14px;margin-right:8px}</style><h3>Amu Creator: ${snapshot.length} 件を送信しますか？（模擬）</h3><div><button id=send onclick="location.href='amu-confirm://send'">送信（模擬）</button><button id=cancel onclick="location.href='amu-confirm://cancel'">取り消し</button></div><ul>${rows}</ul>`;
    const win = new BrowserWindow({
      width: 560,
      height: 640,
      alwaysOnTop: true,
      title: "Amu Creator 送信確認",
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    let settled = false;
    const settle = (answer: "send" | "cancel") => {
      if (settled) return;
      settled = true;
      resolve(answer);
      if (!win.isDestroyed()) win.close();
    };
    win.webContents.on("will-navigate", (event, url) => {
      event.preventDefault();
      settle(url.startsWith("amu-confirm://send") ? "send" : "cancel");
    });
    win.on("closed", () => settle("cancel"));
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });

export const registerCreatorSpike = (wc: WebContents, tabId: string): void => {
  if (!creatorSpikeEnabled()) return;
  const dir = join(tmpdir(), "amu-creator-spike", tabId.replace(/[^a-zA-Z0-9-]/g, "_"));
  mkdirSync(join(dir, "shots"), { recursive: true });
  const log = (event: string, data: unknown) =>
    appendFileSync(
      join(dir, "events.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), event, data })}\n`,
    );
  const state = createSpikeState(() => Date.now());
  let capturing = false;
  let generation = 0;

  const isMainFrame = (event: IpcMainEvent) => event.senderFrame === wc.mainFrame;
  const tooBig = (payload: unknown) =>
    JSON.stringify(payload ?? null).length > SPIKE_LIMITS.maxIpcBytes;
  const pushState = () => wc.send(CREATOR_SPIKE_STATE, { generation, pins: state.pins() });

  wc.on("did-start-navigation", (details) => {
    // Studio rewrites the URL hash while playing; only a new main-frame document revokes.
    if (details.isMainFrame && !details.isSameDocument) {
      state.navigationStarted();
      log("navigation-started", { url: details.url });
    }
  });
  wc.on("did-finish-load", () => {
    const origin = new URL(wc.getURL()).origin;
    if (!LOCAL_ORIGIN.test(origin)) return;
    generation = state.activate();
    wc.send(CREATOR_SPIKE_ACTIVATE, { generation });
    log("activated", { origin, generation });
    // A reload keeps this tab's comments; show them right away.
    pushState();
  });

  const capture = async (gen: unknown, pinId: string, cropRect: unknown) => {
    // The guest is a webview, so read its own viewport from an isolated world the page cannot patch.
    const [vw, vh] = (await wc.executeJavaScriptInIsolatedWorld(999, [
      { code: "[window.innerWidth, window.innerHeight]" },
    ])) as [number, number];
    const viewport = { width: vw, height: vh };
    // Zoomed or partly scrolled previews can push the crop past the viewport;
    // keep the visible part instead of dropping the shot.
    const visible =
      typeof cropRect === "object" && cropRect !== null
        ? clampToViewport(cropRect as Record<string, unknown>, viewport)
        : null;
    cropRect = visible;
    if (!capturing && isUsableRect(cropRect, viewport, viewport.width * viewport.height)) {
      capturing = true;
      try {
        const image = await wc.capturePage({
          x: Math.floor(cropRect.x),
          y: Math.floor(cropRect.y),
          width: Math.ceil(cropRect.width),
          height: Math.ceil(cropRect.height),
        });
        if (gen !== generation) {
          log("shot-discarded", { reason: "stale-generation" });
        } else {
          const resized =
            image.getSize().width > SPIKE_LIMITS.maxShotLongEdge
              ? image.resize({ width: SPIKE_LIMITS.maxShotLongEdge })
              : image;
          const shotPath = join(dir, "shots", `${pinId}.png`);
          writeFileSync(shotPath, resized.toPNG());
          state.setShot(pinId, shotPath);
          log("shot", { pinId: pinId, shotPath, size: resized.getSize(), cropRect });
        }
      } finally {
        capturing = false;
      }
    } else {
      log("shot-skipped", { capturing, cropRect, viewport });
    }
  };

  wc.ipc.on(CREATOR_SPIKE_DRAFT, async (event, gen: unknown, draft: unknown, cropRect: unknown) => {
    if (!isMainFrame(event) || tooBig(draft)) {
      log("draft-rejected", { reason: "frame-or-size" });
      return;
    }
    const result = state.acceptDraft(gen as number, (draft ?? {}) as Record<string, unknown>);
    log("draft", result);
    if (!result.ok) {
      pushState();
      return;
    }
    await capture(gen, result.value.id, cropRect);
    pushState();
  });

  wc.ipc.on(
    CREATOR_SPIKE_LOCATE,
    async (event, gen: unknown, pinId: unknown, place: unknown, cropRect: unknown) => {
      if (!isMainFrame(event) || tooBig(place)) return;
      const result = state.setLocation(
        gen as number,
        String(pinId),
        (place ?? {}) as Record<string, unknown>,
      );
      log("locate", result);
      if (result.ok) await capture(gen, result.value.id, cropRect);
      pushState();
    },
  );

  wc.ipc.on(CREATOR_SPIKE_UPDATE, (event, gen: unknown, pinId: unknown, comment: unknown) => {
    if (!isMainFrame(event)) return;
    log("update", state.updateComment(gen as number, String(pinId), comment));
    pushState();
  });

  wc.ipc.on(CREATOR_SPIKE_PROPOSE, async (event, gen: unknown, pinIds: unknown) => {
    if (!isMainFrame(event)) return;
    const proposal = state.propose(gen as number, pinIds);
    log("propose", proposal);
    pushState();
    if (!proposal.ok) return;
    const response = await confirmInAmuWindow(proposal.value.snapshot);
    if (response !== "send") {
      log("proposal-cancelled", { id: proposal.value.id });
      return;
    }
    const confirmed = state.confirm(proposal.value.id, proposal.value.revisionKey);
    log("confirm", confirmed);
    if (confirmed.ok) {
      appendFileSync(
        join(dir, "sent.jsonl"),
        `${JSON.stringify({ proposalId: confirmed.value.id, snapshot: confirmed.value.snapshot })}\n`,
      );
    }
    pushState();
  });
};
