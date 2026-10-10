/**
 * Keeps the panel's typing away from Studio.
 *
 * Studio handles shortcuts in window capture-phase listeners (Cmd+V there
 * calls `preventDefault()` and runs its own clip paste, which shows "Nothing to
 * paste."). Its "is the user typing?" check reads `event.target`, which outside
 * the panel's closed shadow root is the overlay host, not the textarea, so it
 * treats panel typing as shortcuts. Typeless inserts text by paste or IME, so
 * this broke dictation.
 *
 * The preload installs these listeners on window before any page script runs,
 * so they fire before Studio's. For an event from the panel they stop
 * propagation but never `preventDefault()`: the browser still inserts the text,
 * and Studio never sees the event. Page code cannot remove them, as it never
 * gets the listener references. The panel's own `input` handling cannot rely on
 * propagation after this, so each stopped event is first handed to `deliver`.
 */
export const PANEL_SHIELD_EVENTS = [
  "paste",
  "copy",
  "cut",
  "keydown",
  "keyup",
  "keypress",
  "beforeinput",
  "input",
  "compositionstart",
  "compositionupdate",
  "compositionend",
] as const;

/** An event from inside the overlay: its composed path runs through the host. */
export const shieldsEvent = <T>(path: ReadonlyArray<T>, host: T | null): boolean =>
  host !== null && path.includes(host);

export type PanelShieldDeps<E> = {
  /** Adds a window capture-phase listener with the native `addEventListener`. */
  readonly listen: (type: string, handler: (event: E) => void) => void;
  readonly composedPath: (event: E) => ReadonlyArray<unknown>;
  readonly stopImmediatePropagation: (event: E) => void;
  /** The mounted overlay host, or null while Creator is off. */
  readonly host: () => unknown;
  /** Runs the panel's own handling for an event that will not propagate. */
  readonly deliver: (event: E) => void;
};

export const installPanelShield = <E>(deps: PanelShieldDeps<E>): void => {
  for (const type of PANEL_SHIELD_EVENTS) {
    deps.listen(type, (event) => {
      if (!shieldsEvent(deps.composedPath(event), deps.host() ?? null)) return;
      deps.deliver(event);
      deps.stopImmediatePropagation(event);
    });
  }
};
