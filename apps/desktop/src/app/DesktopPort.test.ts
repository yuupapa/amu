import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { NetService } from "@t3tools/shared/Net";
import { resolveDesktopBackendPort } from "./DesktopApp.ts";

const network = (canListen: boolean) =>
  NetService.of({
    canListenOnHost: () => Effect.succeed(canListen),
    isPortAvailableOnLoopback: () => Effect.succeed(canListen),
    hasListenerOnHost: () => Effect.succeed(!canListen),
    reserveLoopbackPort: () => Effect.succeed(0),
    findAvailablePort: () => Effect.die("Configured Amu port must never silently change"),
  });

describe("Amu backend ownership", () => {
  it.effect("fails before starting a second backend when the configured port is owned", () =>
    Effect.gen(function* () {
      const result = yield* resolveDesktopBackendPort(Option.some(5233)).pipe(
        Effect.provideService(NetService, network(false)),
        Effect.flip,
      );
      assert.equal(result._tag, "DesktopBackendPortUnavailableError");
      assert.equal(result.startPort, 5233);
    }),
  );
  it.effect("keeps the configured port when available", () =>
    Effect.gen(function* () {
      const result = yield* resolveDesktopBackendPort(Option.some(5233)).pipe(
        Effect.provideService(NetService, network(true)),
      );
      assert.deepEqual(result, { port: 5233, selectedByScan: false });
    }),
  );
});
