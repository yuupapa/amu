/**
 * Amu: come back to the same screen after a restart Amu itself asks for
 * (turning network access on or off, installing an update), instead of the
 * chat. The screen is kept for a few minutes only, so a later ordinary start
 * opens as usual. Desktop app only: it runs on hash routes.
 */

const STORAGE_KEY = "amu:return-after-restart";
const FRESH_MS = 3 * 60_000;

type Saved = { hash: string; at: number };

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Right before asking for the restart. */
export function rememberScreenForRestart(now = Date.now()): void {
  const hash = typeof window === "undefined" ? "" : window.location.hash;
  if (!hash.startsWith("#/")) return;
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ hash, at: now } satisfies Saved));
  } catch {
    // Without storage the app opens on its usual screen.
  }
}

/** When the restart did not happen after all. */
export function forgetScreenForRestart(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing kept.
  }
}

/**
 * The screen to open, once: read and removed together. Null when nothing was
 * kept, it is too old, or it is not one of the app's own routes.
 */
export function takeScreenAfterRestart(now = Date.now()): string | null {
  const store = storage();
  if (!store) return null;
  let saved: unknown;
  try {
    saved = JSON.parse(store.getItem(STORAGE_KEY) ?? "null");
  } catch {
    saved = null;
  }
  forgetScreenForRestart();
  if (!saved || typeof saved !== "object") return null;
  const { hash, at } = saved as Partial<Saved>;
  if (typeof hash !== "string" || typeof at !== "number") return null;
  if (!/^#\/[^\s]*$/u.test(hash) || hash.length > 2_000) return null;
  if (now - at < 0 || now - at > FRESH_MS) return null;
  return hash;
}

/** At startup, before the router reads the address. */
export function restoreScreenAfterRestart(): void {
  const hash = takeScreenAfterRestart();
  if (hash && window.location.hash !== hash) window.location.hash = hash;
}

/**
 * Installs an update so that Amu comes back to this screen afterwards; a
 * refused or failed install forgets the screen again.
 */
export async function installUpdateReturningHere<
  R extends {
    readonly accepted: boolean;
    readonly state: { readonly errorContext: string | null };
  },
>(install: () => Promise<R>): Promise<R> {
  rememberScreenForRestart();
  try {
    const result = await install();
    if (!result.accepted || result.state.errorContext === "install") forgetScreenForRestart();
    return result;
  } catch (error) {
    forgetScreenForRestart();
    throw error;
  }
}
