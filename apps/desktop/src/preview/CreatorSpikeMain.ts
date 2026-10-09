// @effect-diagnostics globalDate:off nodeBuiltinImport:off - Throwaway stage-0 spike, gated by AMU_CREATOR_SPIKE=1.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dialog, type IpcMainEvent, type WebContents } from "electron";

import { SPIKE_LIMITS, isUsableRect } from "./creatorSpikeGeometry.ts";
import {
  CREATOR_SPIKE_ACTIVATE,
  CREATOR_SPIKE_DRAFT,
  CREATOR_SPIKE_PROPOSE,
  CREATOR_SPIKE_STATE,
  CREATOR_SPIKE_UPDATE,
  creatorSpikeEnabled,
} from "./CreatorSpikeProtocol.ts";
import { createSpikeState } from "./creatorSpikeState.ts";

const LOCAL_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

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
  });

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
    // The guest is a webview, so read its own viewport from an isolated world the page cannot patch.
    const [vw, vh] = (await wc.executeJavaScriptInIsolatedWorld(999, [
      { code: "[window.innerWidth, window.innerHeight]" },
    ])) as [number, number];
    const viewport = { width: vw, height: vh };
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
          const shotPath = join(dir, "shots", `${result.value.id}.png`);
          writeFileSync(shotPath, resized.toPNG());
          state.setShot(result.value.id, shotPath);
          log("shot", { pinId: result.value.id, shotPath, size: resized.getSize(), cropRect });
        }
      } finally {
        capturing = false;
      }
    } else {
      log("shot-skipped", { capturing, cropRect, viewport });
    }
    pushState();
  });

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
    const lines = proposal.value.snapshot.map(
      (p) =>
        `#${p.number} ${p.timeSec.toFixed(1)}s ${p.comment}${p.shotPath ? "" : "（画像なし）"}`,
    );
    const options = {
      type: "question" as const,
      buttons: ["送信（模擬）", "取り消し"],
      defaultId: 1,
      cancelId: 1,
      message: `Amu Creator: ${proposal.value.snapshot.length} 件を送信しますか？`,
      detail: lines.join("\n"),
    };
    const { response } = await dialog.showMessageBox(options);
    if (response !== 0) {
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
