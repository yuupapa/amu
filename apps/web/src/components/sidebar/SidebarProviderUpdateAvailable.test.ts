import { describe, expect, it } from "vite-plus/test";
import type { ServerProvider } from "@t3tools/contracts";
import { providerUpdateAvailableCandidates } from "./SidebarProviderUpdateAvailable";

const provider = (overrides: Partial<ServerProvider>): ServerProvider =>
  ({
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    version: "0.159.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-02T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "0.159.0",
      latestVersion: "0.160.0",
      updateCommand: "npm install -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: null,
      message: null,
    },
    ...overrides,
  }) as ServerProvider;

describe("providerUpdateAvailableCandidates", () => {
  it("offers outdated CLIs with a one-click update", () => {
    expect(providerUpdateAvailableCandidates([provider({})])).toHaveLength(1);
  });
  it("hides the entry while an update is running or when the CLI is current", () => {
    expect(
      providerUpdateAvailableCandidates([
        provider({
          updateState: {
            status: "running",
            startedAt: null,
            finishedAt: null,
            message: null,
            output: null,
          },
        }),
      ]),
    ).toHaveLength(0);
    expect(
      providerUpdateAvailableCandidates([
        provider({
          versionAdvisory: {
            ...provider({}).versionAdvisory!,
            status: "current",
          } as ServerProvider["versionAdvisory"],
        }),
      ]),
    ).toHaveLength(0);
  });
});
