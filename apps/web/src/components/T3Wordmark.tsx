import type { SVGProps } from "react";
import { APP_BASE_NAME } from "../branding";

/** App wordmark; renders the current app name instead of the upstream "T3" glyph. */
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 150 57" xmlns="http://www.w3.org/2000/svg">
      <text
        x="0"
        y="56"
        fontSize="76"
        fontWeight="700"
        fontFamily="system-ui, sans-serif"
        fill="currentColor"
      >
        {APP_BASE_NAME}
      </text>
    </svg>
  );
}
