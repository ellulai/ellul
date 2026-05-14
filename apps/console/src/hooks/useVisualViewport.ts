// SPDX-License-Identifier: MIT
"use client";

import { useState, useEffect } from "react";

export function useVisualViewport(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const vv = window.visualViewport;
    const sync = () => setHeight(vv ? vv.height : window.innerHeight);
    sync();
    window.addEventListener("resize", sync);
    vv?.addEventListener("resize", sync);
    vv?.addEventListener("scroll", sync);
    return () => {
      window.removeEventListener("resize", sync);
      vv?.removeEventListener("resize", sync);
      vv?.removeEventListener("scroll", sync);
    };
  }, []);

  return height;
}
