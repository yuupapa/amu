import { StrictMode, act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { JevWorkflowPanel } from "./JevWorkflowPanel";
const io = vi.hoisted(() => ({ request: vi.fn(), setState: vi.fn() }));
vi.mock("../../lib/jev", () => ({ jevRequest: io.request, setJevHandoffState: io.setState }));
import { jevFixtureJob as job } from "../../../test/jevFixture";
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  io.request.mockReset();
  io.request.mockImplementation(async (_thread: string, method: string) => {
    switch (method) {
      case "bootstrap":
        return { live_enabled: false, mode: "demo", capabilities: {} };
      case "list":
        return [];
      case "decision_request":
        return job.data.request;
      case "preview":
        return {};
      case "create":
        return job;
      case "get":
        return { job, events: [], calls: [], answer: "模擬回答", copy_path: "/tmp/fictional" };
      default:
        throw Error(method);
    }
  });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
describe("Auto text submission", () => {
  it("starts routing after Send without another approval click, including StrictMode", async () => {
    const created = vi.fn();
    await act(async () => {
      renderer = create(
        createElement(
          StrictMode,
          {},
          createElement(JevWorkflowPanel, {
            threadKey: "fictional-thread",
            submission: {
              task: job.data.request.task,
              source: "/tmp/unused",
              nonce: "fixed-nonce",
            },
            onCreated: created,
            onDismiss: vi.fn(),
          }),
        ),
      );
    });
    expect(io.request.mock.calls.filter((call) => call[1] === "create")).toHaveLength(1);
    expect(io.request).toHaveBeenCalledWith("fictional-thread", "create", {
      nonce: "fixed-nonce",
      request: job.data.request,
    });
    expect(created).toHaveBeenCalledTimes(1);
    expect(created).toHaveBeenCalledWith(job);
  });
  it("passes a fixed model and effort into the decision request", async () => {
    const selection = { model: "gpt-6.1-sol", effort: "medium" };
    await act(async () => {
      renderer = create(
        createElement(JevWorkflowPanel, {
          threadKey: "fictional-thread",
          submission: {
            task: job.data.request.task,
            source: "",
            nonce: "fixed-nonce",
            modelSelection: selection,
          },
          onCreated: vi.fn(),
          onDismiss: vi.fn(),
        }),
      );
    });
    expect(io.request).toHaveBeenCalledWith("fictional-thread", "decision_request", {
      task: job.data.request.task,
      model_selection: selection,
    });
  });
  it("does not hand off after the panel is dismissed while status is loading", async () => {
    const original = io.request.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    io.request.mockImplementation((thread: string, method: string) =>
      method === "get"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(thread, method),
    );
    const created = vi.fn();
    await act(async () => {
      renderer = create(
        createElement(JevWorkflowPanel, {
          threadKey: "fictional-thread",
          submission: { task: job.data.request.task, source: "", nonce: "fixed-nonce" },
          onCreated: created,
          onDismiss: vi.fn(),
        }),
      );
    });
    expect(finish).toBeTypeOf("function");
    await act(async () => {
      renderer!.unmount();
      renderer = undefined;
    });
    await act(async () => finish({ job, events: [], calls: [], copy_path: "/tmp/fictional" }));
    expect(created).not.toHaveBeenCalled();
  });
  it("keeps an unknown create response stopped without sending again on rerender", async () => {
    io.request.mockImplementation(async (_thread: string, method: string) => {
      if (method === "bootstrap") return { live_enabled: false };
      if (method === "list") return [];
      if (method === "decision_request") return job.data.request;
      if (method === "preview") return {};
      if (method === "create") throw Error("結果不明・再送禁止");
    });
    const props = {
      threadKey: "fictional-thread",
      submission: { task: job.data.request.task, source: "", nonce: "fixed-nonce" },
      onCreated: vi.fn(),
      onDismiss: vi.fn(),
    };
    await act(async () => {
      renderer = create(createElement(JevWorkflowPanel, props));
    });
    await act(async () => {
      renderer!.update(createElement(JevWorkflowPanel, { ...props }));
    });
    expect(io.request.mock.calls.filter((call) => call[1] === "create")).toHaveLength(1);
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain("再送禁止");
  });
});
