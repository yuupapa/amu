/**
 * Which preview tabs a viewer should bring forward after a session update: a
 * tab an agent opened with `reveal` (a new tab, or a fresh `revealRequest` on
 * an existing one). ChatView runs this on every session change and applies
 * the actions; the first pass after a load is only a baseline, so reloads
 * never reopen tabs the user dismissed.
 *
 * - With "auto-show floating preview" on, or a forced request: a tab that is
 *   not a panel tab floats over the chat; a forced one already in the panel
 *   comes to the front.
 * - With it off: an Amu Creator tab opens in the right panel, since the agent
 *   opened it for the user to review; other tabs stay where they are.
 *
 * Server tabs need the environment's browser; desktop tabs (Creator tabs are
 * always desktop tabs) need the Electron client.
 */
import type { PreviewSessionSnapshot } from "@t3tools/contracts";

export type RevealSession = Pick<
  PreviewSessionSnapshot,
  "tabId" | "runtime" | "reveal" | "revealRequest" | "creator"
>;

export type RevealSurface = {
  readonly id: string;
  readonly kind: string;
  readonly resourceId?: unknown;
};

export type PreviewRevealAction =
  | { readonly kind: "float"; readonly tabId: string }
  | { readonly kind: "activate"; readonly surfaceId: string }
  | { readonly kind: "panel"; readonly tabId: string };

/** Tab id -> the reveal request id last seen for it. */
export type PreviewRevealBaseline = ReadonlyMap<string, string | undefined>;

export function revealableSessions<S extends RevealSession>(
  sessions: ReadonlyArray<S>,
  hosts: { readonly server: boolean; readonly desktop: boolean },
): S[] {
  return sessions.filter((session) =>
    session.runtime === "server" ? hosts.server : hosts.desktop,
  );
}

export function previewRevealBaseline(
  sessions: ReadonlyArray<RevealSession>,
): Map<string, string | undefined> {
  return new Map(sessions.map((session) => [session.tabId, session.revealRequest?.id]));
}

export function previewRevealActions(input: {
  readonly sessions: ReadonlyArray<RevealSession>;
  readonly previous: PreviewRevealBaseline;
  readonly autoShowFloating: boolean;
  /** The right panel's surfaces as rendered before this update. */
  readonly surfaces: ReadonlyArray<RevealSurface>;
}): PreviewRevealAction[] {
  const actions: PreviewRevealAction[] = [];
  for (const session of input.sessions) {
    const requested = session.revealRequest;
    const fresh = requested
      ? input.previous.get(session.tabId) !== requested.id
      : !input.previous.has(session.tabId);
    if (!fresh || session.reveal !== true) continue;
    const forced = requested?.force === true;
    const surface = input.surfaces.find(
      (entry) => entry.kind === "preview" && entry.resourceId === session.tabId,
    );
    if (!input.autoShowFloating && !forced) {
      if (session.creator !== undefined) actions.push({ kind: "panel", tabId: session.tabId });
      continue;
    }
    if (surface && forced) actions.push({ kind: "activate", surfaceId: surface.id });
    else if (!surface) actions.push({ kind: "float", tabId: session.tabId });
  }
  return actions;
}
