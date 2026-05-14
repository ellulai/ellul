// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

import type { SVGProps } from "react";

export function EllulLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" {...props}>
      <rect width="32" height="32" rx="6" fill="#0B0B0F" />
      <text
        x="16"
        y="22"
        textAnchor="middle"
        fontFamily="ui-monospace, monospace"
        fontSize="20"
        fontWeight="700"
        fill="#F0A65A"
      >
        e
      </text>
    </svg>
  );
}
