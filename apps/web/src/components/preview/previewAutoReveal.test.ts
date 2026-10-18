import type { PreviewSessionSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  previewRevealActions,
  previewRevealBaseline,
  previewRevealPass,
  revealableSessions,
  type PreviewRevealBaseline,
  type RevealSurface,
} from "./previewAutoReveal";

const session = (
  tabId: string,
  overrides: Partial<PreviewSessionSnapshot> = {},
): PreviewSessionSnapshot => ({
  threadId: "thread-1" as PreviewSessionSnapshot["threadId"],
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-10-10T00:00:00.000Z",
  ...overrides,
});

const creatorTab = (tabId: string, overrides: Partial<PreviewSessionSnapshot> = {}) =>
  session(tabId, {
    reveal: true,
    creator: {
      bindingId: "11111111-1111-4111-8111-111111111111" as never,
      label: "promo",
    },
    ...overrides,
  });

const agentServerTab = (tabId: string, revealId: string, force = false) =>
  session(tabId, { runtime: "server", reveal: true, revealRequest: { id: revealId, force } });

const surfaceFor = (tabId: string): RevealSurface => ({
  id: `browser:${tabId}`,
  kind: "preview",
  resourceId: tabId,
});

/** Runs one effect pass the way ChatView does: baseline from before, sessions now. */
const pass = (
  before: PreviewSessionSnapshot[],
  now: PreviewSessionSnapshot[],
  options: {
    autoShow: boolean;
    surfaces?: RevealSurface[];
    hosts?: { server: boolean; desktop: boolean };
  },
) =>
  previewRevealActions({
    sessions: now,
    previous: previewRevealBaseline(before),
    autoShowFloating: options.autoShow,
    surfaces: options.surfaces ?? [],
    hosts: options.hosts ?? { server: true, desktop: true },
  });

describe("revealableSessions", () => {
  const desktopTab = creatorTab("creator");
  const serverTab = agentServerTab("agent", "r1");

  it("keeps server tabs only where the environment hosts them, desktop tabs only in Electron", () => {
    const sessions = [desktopTab, serverTab];
    expect(revealableSessions(sessions, { server: true, desktop: true })).toEqual(sessions);
    expect(revealableSessions(sessions, { server: true, desktop: false })).toEqual([serverTab]);
    expect(revealableSessions(sessions, { server: false, desktop: true })).toEqual([desktopTab]);
  });
});

describe("previewRevealActions", () => {
  it("floats an agent browser tab when auto-show is on", () => {
    expect(pass([], [agentServerTab("agent", "r1")], { autoShow: true })).toEqual([
      { kind: "float", tabId: "agent" },
    ]);
  });

  it("opens a Creator tab an agent opened in the panel, then in its own window", () => {
    // Creator tabs are desktop tabs, which the reveal pass used to skip; they
    // never float, whatever auto-show says.
    for (const autoShow of [true, false]) {
      expect(pass([], [creatorTab("creator")], { autoShow })).toEqual([
        { kind: "panel", tabId: "creator" },
        { kind: "creator-window", tabId: "creator" },
      ]);
    }
  });

  it("opens an Amu Gallery tab an agent opened the same way as Creator", () => {
    const galleryTab = session("gallery", { reveal: true, gallery: { label: "素材ギャラリー" } });
    for (const autoShow of [true, false]) {
      expect(pass([], [galleryTab], { autoShow })).toEqual([
        { kind: "panel", tabId: "gallery" },
        { kind: "creator-window", tabId: "gallery" },
      ]);
    }
  });

  it("leaves other agent tabs where they are when auto-show is off", () => {
    // An ordinary agent browser tab stays quiet unless forced.
    expect(pass([], [agentServerTab("agent", "r1")], { autoShow: false })).toEqual([]);
    expect(pass([], [agentServerTab("agent", "r1", true)], { autoShow: false })).toEqual([
      { kind: "float", tabId: "agent" },
    ]);
  });

  it("reveals only once, and never tabs that were there before (reloads)", () => {
    const tab = creatorTab("creator");
    expect(pass([tab], [tab], { autoShow: true })).toEqual([]);
    expect(pass([tab], [tab], { autoShow: false })).toEqual([]);
  });

  it("ignores tabs nobody asked to show (the user's own Creator open, plain tabs)", () => {
    const userOpened = creatorTab("creator", { reveal: undefined });
    expect(pass([], [userOpened, session("plain")], { autoShow: true })).toEqual([]);
    expect(pass([], [userOpened], { autoShow: false })).toEqual([]);
  });

  it("brings a forced reveal of an existing panel tab to the front", () => {
    const before = agentServerTab("agent", "r1");
    const after = agentServerTab("agent", "r2", true);
    expect(pass([before], [after], { autoShow: true, surfaces: [surfaceFor("agent")] })).toEqual([
      { kind: "activate", surfaceId: "browser:agent" },
    ]);
    // Not forced and already a panel tab: left where it is.
    const quiet = agentServerTab("agent", "r3");
    expect(pass([after], [quiet], { autoShow: true, surfaces: [surfaceFor("agent")] })).toEqual([]);
  });
});

describe("tabs this client cannot host", () => {
  it("are never revealed", () => {
    const hosts = { server: false, desktop: true };
    expect(pass([], [agentServerTab("agent", "r1")], { autoShow: true, hosts })).toEqual([]);
    expect(
      pass([], [creatorTab("creator")], {
        autoShow: true,
        hosts: { server: true, desktop: false },
      }),
    ).toEqual([]);
  });
});

describe("previewRevealPass (one ChatView effect run)", () => {
  const options = (server: boolean) => ({
    autoShowFloating: true,
    surfaces: [],
    hosts: { server, desktop: true },
  });

  it("only records a baseline on the first run after a load", () => {
    const first = previewRevealPass(undefined, [creatorTab("creator")], options(true));
    expect(first.actions).toEqual([]);
    expect([...first.baseline.keys()]).toEqual(["creator"]);
  });

  it("does not reveal old tabs when the server browser becomes available after the list loaded", () => {
    // Review finding: the capability and the preview list come from separate
    // RPCs. A baseline taken from the host-filtered list missed the server tabs,
    // so they all looked new once the capability arrived, and floated again.
    const tabs = [agentServerTab("agent", "r1"), creatorTab("creator")];
    const first = previewRevealPass(undefined, tabs, options(false));
    const second = previewRevealPass(first.baseline, tabs, options(true));
    expect(second.actions).toEqual([]);
    // A genuinely new request after that is still shown.
    const later = [agentServerTab("agent", "r2"), creatorTab("creator")];
    expect(previewRevealPass(second.baseline, later, options(true)).actions).toEqual([
      { kind: "float", tabId: "agent" },
    ]);
  });

  it("keeps baselines for tabs it cannot host yet", () => {
    const tabs = [agentServerTab("agent", "r1")];
    const baseline: PreviewRevealBaseline = previewRevealPass(
      undefined,
      tabs,
      options(false),
    ).baseline;
    expect(baseline.get("agent")).toBe("r1");
  });
});
