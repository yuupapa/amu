import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
  "x-amu-auto",
] as const;

/** Call only after validating the session and orchestration operate scope. */
export function isLocalLunaAutoRequest(
  url: URL,
  headers: Readonly<Record<string, string | undefined>>,
): boolean {
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    headers["x-amu-auto"] !== "1"
  )
    return false;
  const origin = headers.origin;
  if (origin === undefined || origin === url.origin) return true;
  // Electron renders from a privileged custom origin and reaches its loopback
  // backend using the existing IPC bearer. Browser cookies alone cannot opt in.
  return (
    ["t3code://app", "t3code-dev://app"].includes(origin) &&
    /^Bearer\s+\S+$/i.test(headers.authorization ?? "")
  );
}
