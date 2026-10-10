/**
 * DOM primitives captured when the preview preload loads, before any page
 * script runs. Studio (or a composition) could later patch
 * `EventTarget.prototype` and friends; the overlay only uses these copies, so
 * a patched prototype cannot see, drop or fake its listeners.
 *
 * `isTrusted` is a [LegacyUnforgeable] own property of every event in Chromium,
 * so a page cannot redefine it; a prototype getter is used if one exists.
 */
const nativeAdd = EventTarget.prototype.addEventListener;
const nativeRemove = EventTarget.prototype.removeEventListener;
const nativeAttachShadow = Element.prototype.attachShadow;
const nativeComposedPath = Event.prototype.composedPath;
const nativePreventDefault = Event.prototype.preventDefault;
const nativeStopPropagation = Event.prototype.stopPropagation;
const nativeStopImmediatePropagation = Event.prototype.stopImmediatePropagation;
const isTrustedGetter = Object.getOwnPropertyDescriptor(Event.prototype, "isTrusted")?.get;

export const NativeMutationObserver = MutationObserver;

/** Adds a listener with the original `addEventListener`; returns its remover. */
export const listen = <E extends Event = Event>(
  target: EventTarget,
  type: string,
  handler: (event: E) => void,
  options?: AddEventListenerOptions,
): (() => void) => {
  const listener = handler as unknown as EventListener;
  Reflect.apply(nativeAdd, target, [type, listener, options]);
  return () => Reflect.apply(nativeRemove, target, [type, listener, options]);
};

export const attachClosedShadow = (host: Element): ShadowRoot =>
  Reflect.apply(nativeAttachShadow, host, [{ mode: "closed" }]) as ShadowRoot;

export const composedPath = (event: Event): EventTarget[] =>
  Reflect.apply(nativeComposedPath, event, []) as EventTarget[];

export const isTrustedEvent = (event: Event): boolean =>
  (isTrustedGetter === undefined ? event.isTrusted : Reflect.apply(isTrustedGetter, event, [])) ===
  true;

/** Keeps an event from the page: no default action, no other listener. */
export const swallow = (event: Event): void => {
  Reflect.apply(nativePreventDefault, event, []);
  Reflect.apply(nativeStopImmediatePropagation, event, []);
};

export const stopPropagation = (event: Event): void => {
  Reflect.apply(nativeStopPropagation, event, []);
};
