import { describe, expect, it } from "vite-plus/test";

import { makeRateGate } from "./rateGate.ts";

describe("rateGate", () => {
  it("refuses the 3rd draft inside one second and recovers after it", () => {
    const gate = makeRateGate();
    expect(gate.allow("p1", "draft", 0)).toBe(true);
    expect(gate.allow("p1", "draft", 100)).toBe(true);
    expect(gate.allow("p1", "draft", 200)).toBe(false);
    expect(gate.allow("p1", "draft", 999)).toBe(false);
    expect(gate.allow("p1", "draft", 1_000)).toBe(true);
  });

  it("allows one proposal per two seconds", () => {
    const gate = makeRateGate();
    expect(gate.allow("p1", "propose", 0)).toBe(true);
    expect(gate.allow("p1", "propose", 1_999)).toBe(false);
    expect(gate.allow("p1", "propose", 2_000)).toBe(true);
  });

  it("keeps keys and kinds independent", () => {
    const gate = makeRateGate();
    expect(gate.allow("p1", "propose", 0)).toBe(true);
    expect(gate.allow("p2", "propose", 0)).toBe(true);
    expect(gate.allow("p1", "draft", 0)).toBe(true);
  });

  it("does not share state between gates", () => {
    expect(makeRateGate().allow("p1", "propose", 0)).toBe(true);
    expect(makeRateGate().allow("p1", "propose", 0)).toBe(true);
  });
});
