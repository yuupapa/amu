import { describe, vi } from "vite-plus/test";
import { expect, it } from "@effect/vitest";
import { ServerProvider } from "@t3tools/contracts";
import { LunaDecisionBroker } from "./LunaDecision.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpRouter from "effect/http/HttpRouter";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import { layerLunaAutoRoute as lunaAutoRouteLayer } from "../http.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const token = "offline-local-route-dev-token-long-enough";
const config = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const value = yield* ServerConfig.ServerConfig;
    return {
      ...value,
      mode: "web" as const,
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(token),
    };
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "amu-local-route-test-" })));
const auth = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(config),
);
// Cancellation traverses the real authentication and route guards without a
// provider lookup, process spawn, inference, or persistent live-app state.
const unused = () => Effect.die("Provider operations must not run in the cancellation fixture");
const providers = Layer.succeed(
  ProviderRegistry,
  ProviderRegistry.of({
    getProviders: unused(),
    refresh: unused,
    refreshInstance: unused,
    refreshWorkspaceSnapshot: unused,
    getProviderMaintenanceCapabilitiesForInstance: unused,
    setProviderMaintenanceActionState: unused,
    streamChanges: Stream.empty,
  }),
);
const routes = lunaAutoRouteLayer.pipe(
  Layer.provide(providers),
  Layer.provide(Settings.layerTest()),
  Layer.provideMerge(auth),
  Layer.provide(config),
  Layer.provide(NodeServices.layer),
);

describe("Luna Auto authenticated local HTTP route", () => {
  it.effect(
    "allows exact Electron origins with valid existing bearer and rejects remote or unauthenticated requests",
    () =>
      Effect.gen(function* () {
        const crypto = yield* Crypto.Crypto;
        const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
          Context.add(
            ServerSecretStore.ServerSecretStore,
            ServerSecretStore.ServerSecretStore.of({
              get: () => Effect.succeedNone,
              set: () => Effect.void,
              create: () => Effect.void,
              getOrCreateRandom: () => Effect.die("Secret creation must not run in this fixture"),
              remove: () => Effect.void,
            }),
          ),
        );
        yield* Effect.acquireUseRelease(
          Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
          (web) =>
            Effect.promise(async () => {
              for (const [base, origin, bearer, marker, expected] of [
                ["http://127.0.0.1:5233", "t3code://app", token, "1", 200],
                ["http://localhost:5233", "t3code-dev://app", token, "1", 200],
                ["http://[::1]:5233", "t3code://app", token, "1", 200],
                ["http://127.0.0.1:5233", "http://127.0.0.1:5233", token, "1", 200],
                ["http://127.0.0.1:5233", undefined, token, "1", 200],
                ["http://127.0.0.1:5233", "t3code://app", undefined, "1", 401],
                ["http://127.0.0.1:5233", "t3code://app", "invalid", "1", 401],
                ["http://127.0.0.1:5233", "https://remote.example", token, "1", 403],
                ["http://127.0.0.1:5233", "null", token, "1", 403],
                ["http://127.0.0.1:5233", "t3code://evil", token, "1", 403],
                ["http://127.0.0.1:5233", "t3code://app:123", token, "1", 403],
                ["http://127.0.0.1:5233", "t3code://app/path", token, "1", 403],
                ["http://127.0.0.1:5233", "t3code://app", token, undefined, 403],
                ["http://192.168.1.2:5233", "t3code://app", token, "1", 403],
                ["https://remote.example", "https://remote.example", token, "1", 403],
              ] as const) {
                const response = await web.handler(
                  new Request(`${base}/api/luna-auto`, {
                    method: "POST",
                    headers: {
                      host: new URL(base).host,
                      "content-type": "application/json",
                      ...(origin ? { origin } : {}),
                      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
                      ...(marker ? { "x-amu-auto": marker } : {}),
                    },
                    body: encodeJson({ id: "offline-local-route-000001", action: "cancel" }),
                  }),
                  requestContext,
                );
                expect(
                  response.status,
                  `${base} ${origin} ${bearer === token ? "valid" : "invalid/absent"} ${response.status === 500 ? await response.text() : ""}`,
                ).toBe(expected);
                if (expected === 200) expect(await response.json()).toEqual({ cancelled: true });
              }
            }),
          (web) => Effect.promise(() => web.dispose()),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const decodeProvider = Schema.decodeUnknownSync(ServerProvider);
const legacyJudge = decodeProvider({
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "offline-fixture",
  status: "ready",
  auth: { status: "authenticated", type: "chatgpt" },
  checkedAt: "2026-10-02T00:00:00Z",
  models: [{ slug: "gpt-6-luna", name: "Luna", isCustom: false, capabilities: null }],
});
const legacyRoutes = lunaAutoRouteLayer.pipe(
  Layer.provide(Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([legacyJudge]) })),
  Layer.provide(
    Settings.layerTest({
      providers: {
        codex: {
          setupMode: "existing",
          binaryPath: "/offline-codex",
          homePath: "/offline-existing-home",
        },
      },
      providerInstances: {},
    }),
  ),
  Layer.provideMerge(auth),
  Layer.provide(config),
  Layer.provide(NodeServices.layer),
);
it.effect(
  "routes a legacy Codex configuration to the decision broker without native CLI execution",
  () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
        Context.add(
          ServerSecretStore.ServerSecretStore,
          ServerSecretStore.ServerSecretStore.of({
            get: () => Effect.succeedNone,
            set: () => Effect.void,
            create: () => Effect.void,
            getOrCreateRandom: () => Effect.die("No secret creation in fixture"),
            remove: () => Effect.void,
          }),
        ),
      );
      yield* Effect.acquireUseRelease(
        Effect.sync(() => ({
          web: HttpRouter.toWebHandler(legacyRoutes, { disableLogger: true }),
          judge: vi.spyOn(LunaDecisionBroker.prototype, "decide").mockResolvedValue({
            model: "gpt-6-luna",
            effort: "default",
            reason: "簡単な質問のため",
          }),
        })),
        ({ web, judge }) =>
          Effect.promise(async () => {
            const response = await web.handler(
              new Request("http://127.0.0.1:5233/api/luna-auto", {
                method: "POST",
                headers: {
                  host: "127.0.0.1:5233",
                  origin: "t3code://app",
                  authorization: `Bearer ${token}`,
                  "content-type": "application/json",
                  "x-amu-auto": "1",
                },
                body: encodeJson({
                  id: "offline-legacy-route-00001",
                  action: "decide",
                  prompt: "架空の依頼",
                  models: [{ instanceId: "codex", model: "gpt-6-luna" }],
                }),
              }),
              requestContext,
            );
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({ result: { model: "gpt-6-luna" } });
            expect(judge).toHaveBeenCalledOnce();
            expect(judge.mock.calls[0]?.[1].runtime.binary).toBe("/offline-codex");
            expect(judge.mock.calls[0]?.[1].runtime.home).toBe("/offline-existing-home");
          }),
        ({ web, judge }) =>
          Effect.promise(async () => {
            judge.mockRestore();
            await web.dispose();
          }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

describe("isLoopbackRemoteAddress", () => {
  it("accepts only this machine's own addresses", async () => {
    const { isLocalLunaAutoRequest, isLoopbackRemoteAddress } = await import("../httpCors.ts");
    for (const address of ["127.0.0.1", "127.8.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(isLoopbackRemoteAddress(address), address).toBe(true);
    }
    for (const address of ["192.168.1.2", "10.0.0.1", "::ffff:192.168.1.2", "fe80::1"]) {
      expect(isLoopbackRemoteAddress(address), address).toBe(false);
    }
    // A spoofed Host header does not help a request from another machine.
    const url = new URL("http://localhost:5233/api/luna-auto");
    expect(isLocalLunaAutoRequest(url, { "x-amu-auto": "1" }, "192.168.1.2")).toBe(false);
    expect(isLocalLunaAutoRequest(url, { "x-amu-auto": "1" }, "127.0.0.1")).toBe(true);
  });
});
