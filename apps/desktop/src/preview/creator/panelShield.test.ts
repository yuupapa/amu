import { describe, expect, it } from "vite-plus/test";

import { installPanelShield, PANEL_SHIELD_EVENTS, shieldsEvent } from "./panelShield.ts";

const host = { name: "host" };
const textarea = { name: "textarea" };
const studioRoot = { name: "studio-root" };
const win = { name: "window" };

describe("shieldsEvent", () => {
  it("shields an event whose composed path runs through the overlay host", () => {
    expect(shieldsEvent([host, studioRoot, win], host)).toBe(true);
    expect(shieldsEvent([textarea, host, win], host)).toBe(true);
  });

  it("leaves Studio's own events and events with no overlay alone", () => {
    expect(shieldsEvent([studioRoot, win], host)).toBe(false);
    expect(shieldsEvent([host, win], null)).toBe(false);
    expect(shieldsEvent([], host)).toBe(false);
  });
});

describe("installPanelShield", () => {
  const harness = (currentHost: object | null) => {
    const listeners = new Map<string, (event: object) => void>();
    const stopped: object[] = [];
    const delivered: object[] = [];
    const paths = new Map<object, object[]>();
    installPanelShield<object>({
      listen: (type, handler) => {
        listeners.set(type, handler);
      },
      composedPath: (event) => paths.get(event) ?? [],
      stopImmediatePropagation: (event) => stopped.push(event),
      host: () => currentHost,
      deliver: (event) => delivered.push(event),
    });
    const fire = (type: string, path: object[]) => {
      const event = { type };
      paths.set(event, path);
      listeners.get(type)?.(event);
      return event;
    };
    return { listeners, stopped, delivered, fire };
  };

  it("listens to paste, clipboard, key, input and composition events", () => {
    const { listeners } = harness(host);
    expect([...listeners.keys()].toSorted()).toEqual([...PANEL_SHIELD_EVENTS].toSorted());
    for (const type of [
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
    ]) {
      expect(listeners.has(type)).toBe(true);
    }
  });

  it("stops a panel event from reaching Studio and hands it to the panel first", () => {
    const { stopped, delivered, fire } = harness(host);
    const paste = fire("paste", [host, win]);
    const input = fire("input", [host, win]);
    expect(stopped).toEqual([paste, input]);
    expect(delivered).toEqual([paste, input]);
  });

  it("lets Studio's own events through untouched", () => {
    const { stopped, delivered, fire } = harness(host);
    fire("keydown", [studioRoot, win]);
    expect(stopped).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it("does nothing while no overlay is mounted", () => {
    const { stopped, fire } = harness(null);
    fire("paste", [host, win]);
    expect(stopped).toEqual([]);
  });
});
