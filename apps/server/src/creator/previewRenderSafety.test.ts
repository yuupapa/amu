// @effect-diagnostics nodeBuiltinImport:off - execute the serialized preview adapter without a browser.
import * as NodeVM from "node:vm";
import { describe, expect, it } from "@effect/vitest";
import { protectStudioAdapter, renderSafetyNodeOptions } from "./previewRenderSafety.ts";
import * as NodeFS from "node:fs";

const fixture = NodeFS.readFileSync(
  new URL("./fixtures/render-adapter.mjs", import.meta.url),
  "utf8",
);
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

function setup(admit: () => Promise<void>) {
  let released = 0;
  const sandbox = { Symbol, AbortController };
  Object.assign(sandbox, {
    [Symbol.for("amu.render.acquire")]: admit,
    [Symbol.for("amu.render.release")]: () => {
      released++;
    },
  });
  const fn = NodeVM.runInNewContext(
    protectStudioAdapter(fixture).replace("export function", "function") + "\nstartRender",
    sandbox,
  );
  return { fn, released: () => released };
}

describe("native render safety adapter", () => {
  it("holds admission and uses one worker until render cleanup actually finishes", async () => {
    const admitted = deferred(),
      executing = deferred(),
      cleanup = deferred();
    const test = setup(() => admitted.promise);
    let count = 0;
    let workers = 0;
    const result = test.fn(
      { project: { dir: "/project" } },
      async () => ({
        createRenderJob: (options: { workers: number }) => {
          count++;
          workers = options.workers;
          return {};
        },
        executeRenderJob: async () => {
          executing.resolve();
          await cleanup.promise;
        },
      }),
      new Map(),
    );
    expect(count).toBe(0);
    admitted.resolve();
    await executing.promise;
    result.state.cancel(); // A cancelled UI state must not release a running renderer.
    expect(test.released()).toBe(0);
    expect(workers).toBe(1);
    cleanup.resolve();
    await result.run;
    expect(test.released()).toBe(1);
    expect(result.state.status).toBe("cancelled");
  });

  it("does not create a renderer if admission refuses", async () => {
    const test = setup(async () => {
      throw new Error("Another media job is running.");
    });
    let loaded = false;
    const result = test.fn(
      { project: { dir: "/project" } },
      async () => {
        loaded = true;
        throw new Error("must not run");
      },
      new Map(),
    );
    await result.run;
    expect(loaded).toBe(false);
    expect(result.state.status).toBe("failed");
    expect(result.state.error).toContain("Another media job");
  });

  it("releases after a failed render", async () => {
    const test = setup(async () => {});
    const result = test.fn(
      { project: { dir: "/project" } },
      async () => ({
        createRenderJob: () => ({}),
        executeRenderJob: async () => {
          throw new Error("render failed");
        },
      }),
      new Map(),
    );
    await result.run;
    expect(result.state.status).toBe("failed");
    expect(test.released()).toBe(1);
  });

  it("refuses an incompatible or already modified adapter", () => {
    expect(() => protectStudioAdapter("new version")).toThrow("incompatible");
    expect(() => protectStudioAdapter(protectStudioAdapter(fixture))).toThrow("incompatible");
  });

  it("serializes a self-contained preload and preserves existing Node options", () => {
    const options = renderSafetyNodeOptions("--no-warnings");
    const source = Buffer.from(options.split("base64,")[1]!, "base64").toString();
    expect(options.startsWith("--no-warnings --import=")).toBe(true);
    expect(source).not.toMatch(/@@\w+@@/);
    const hooks: { load?: Function } = {};
    NodeVM.runInNewContext(source, {
      process: {
        getBuiltinModule: (name: string) =>
          name === "node:http"
            ? {
                Server: class {
                  emit() {}
                },
              }
            : name === "node:module"
              ? { registerHooks: (h: object) => Object.assign(hooks, h) }
              : name === "node:url"
                ? { fileURLToPath: (url: string) => new URL(url).pathname }
                : {
                    spawn: () => {
                      throw new Error("not used");
                    },
                  },
      },
      Symbol,
      Map,
    });
    const protectedModule = hooks.load!(
      "file:///tmp/hyperframes/dist/studioServer-demo.js",
      {},
      () => ({ source: fixture }),
    );
    expect(protectedModule.source).toContain("workers: 1");
    expect(
      hooks.load!("file:///tmp/unrelated.js", {}, () => ({ source: "untouched" })).source,
    ).toBe("untouched");
  });
});
