import { describe, expect, it } from "vite-plus/test";

import { installSocketTypeOfServiceGuard } from "./socketTypeOfServiceGuard.ts";

describe("installSocketTypeOfServiceGuard", () => {
  it("swallows errors from setTypeOfService and returns the socket", () => {
    const prototype = {
      setTypeOfService() {
        throw Object.assign(new Error("setTypeOfService EINVAL"), { code: "EINVAL" });
      },
    };
    installSocketTypeOfServiceGuard(prototype as never);
    const socket = Object.create(prototype);
    expect(socket.setTypeOfService(0x10)).toBe(socket);
  });

  it("passes successful calls through and wraps only once", () => {
    const calls: Array<number> = [];
    const prototype = {
      setTypeOfService(tos: number) {
        calls.push(tos);
        return "original";
      },
    };
    installSocketTypeOfServiceGuard(prototype as never);
    const wrapped = prototype.setTypeOfService;
    installSocketTypeOfServiceGuard(prototype as never);
    expect(prototype.setTypeOfService).toBe(wrapped);
    expect(Object.create(prototype).setTypeOfService(8)).toBe("original");
    expect(calls).toEqual([8]);
  });

  it("does nothing when setTypeOfService is missing", () => {
    const prototype = {};
    installSocketTypeOfServiceGuard(prototype as never);
    expect(prototype).toEqual({});
  });
});
