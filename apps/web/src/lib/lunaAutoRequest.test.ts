import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { lunaAutoRequest } from "./lunaAuto";
import { __resetDesktopPrimaryAuthForTests } from "../environments/primary/desktopAuth";

const body = { id: "offline-request-00000001", action: "cancel" };
const token = "offline-existing-bearer";
const getBearer = vi.fn(async () => token);
const transport = vi.fn(async (_url: string, _options: RequestInit) =>
  Response.json({ result: "offline-response" }),
);
function desktop(target: string, page = "t3code://app/") {
  vi.stubGlobal("window", {
    location: { href: page, origin: page.replace(/\/$/, "") },
    desktopBridge: {
      getLocalEnvironmentEnabled: () => true,
      getLocalEnvironmentBootstraps: () => [
        { id: "primary", httpBaseUrl: target, wsBaseUrl: target.replace(/^http/, "ws") },
      ],
      getLocalEnvironmentBearerToken: getBearer,
    },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  __resetDesktopPrimaryAuthForTests();
  vi.stubGlobal("fetch", transport);
});
afterEach(() => {
  __resetDesktopPrimaryAuthForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("Luna Auto local desktop transport", () => {
  it.each(["t3code://app/", "t3code-dev://app/"])(
    "uses the IPC loopback target and existing bearer from %s",
    async (page) => {
      desktop("http://127.0.0.1:5233/", page);
      expect(await lunaAutoRequest(body)).toBe("offline-response");
      expect(getBearer).toHaveBeenCalledOnce();
      expect(transport).toHaveBeenCalledOnce();
      expect(transport.mock.calls[0]).toEqual([
        "http://127.0.0.1:5233/api/luna-auto",
        expect.objectContaining({
          method: "POST",
          credentials: "omit",
          headers: {
            "Content-Type": "application/json",
            "X-Amu-Auto": "1",
            Authorization: `Bearer ${token}`,
          },
        }),
      ]);
    },
  );
  it.each(["http://localhost:5233/", "http://[::1]:5233/"])(
    "supports loopback endpoint %s",
    async (target) => {
      desktop(target);
      await lunaAutoRequest(body);
      expect(transport).toHaveBeenCalledOnce();
    },
  );
  it.each([
    "https://remote.example/",
    "http://192.168.1.2:5233/",
    "http://100.90.1.2:5233/",
    "http://localhost.evil.test:5233/",
    "t3code://localhost/",
  ])("rejects %s before fetching a bearer or sending", async (target) => {
    desktop(target);
    await expect(lunaAutoRequest(body)).rejects.toThrow("ローカル");
    expect(getBearer).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });
  it("does not send when existing IPC authentication fails", async () => {
    desktop("http://127.0.0.1:5233/");
    getBearer.mockRejectedValueOnce(new Error("existing auth unavailable"));
    await expect(lunaAutoRequest(body)).rejects.toThrow("auth unavailable");
    expect(transport).not.toHaveBeenCalled();
  });
  it("uses the established cookie session for a same-origin loopback browser", async () => {
    vi.stubGlobal("window", { location: new URL("http://localhost:5233/") });
    await lunaAutoRequest(body);
    expect(getBearer).not.toHaveBeenCalled();
    expect(transport.mock.calls[0]?.[1]).toMatchObject({
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-Amu-Auto": "1" },
    });
  });
});
