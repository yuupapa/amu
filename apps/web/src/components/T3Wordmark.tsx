import type { SVGProps } from "react";

/**
 * Amu: the upstream T3 mark is replaced by Amu's own icon wherever the app
 * shows its mark (lifecycle rows, the welcome wizard, assistant avatars).
 * The name stays so upstream call sites keep working unchanged.
 */
export function T3Wordmark({
  className,
  "aria-label": ariaLabel,
  "aria-hidden": ariaHidden,
}: SVGProps<SVGSVGElement>) {
  return (
    <img
      src="/apple-touch-icon.png"
      alt={ariaLabel ?? ""}
      aria-hidden={ariaHidden}
      className={className}
      draggable={false}
      style={{ aspectRatio: "1 / 1", objectFit: "contain", borderRadius: "22%" }}
    />
  );
}
