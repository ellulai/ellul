// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 ellul.ai. All rights reserved.

import { describe, expect, it, vi } from "vitest";
import { startPreviewKeepalive } from "./preview-keepalive";

describe("startPreviewKeepalive", () => {
  it("sends an immediate ping when visible", () => {
    const send = vi.fn();
    const visListener: { cb: (() => void) | null } = { cb: null };
    const h = startPreviewKeepalive({
      appDirectory: "a",
      port: 4000,
      send,
      isVisible: () => true,
      onVisibilityChange: (cb) => { visListener.cb = cb; return () => { visListener.cb = null; }; },
      now: () => 1000,
    });
    expect(send).toHaveBeenCalledWith({ appDirectory: "a", port: 4000, at: 1000 });
    h.stop();
  });

  it("does not send when hidden", () => {
    const send = vi.fn();
    const h = startPreviewKeepalive({
      appDirectory: "a",
      port: 4000,
      send,
      isVisible: () => false,
      onVisibilityChange: () => () => {},
    });
    expect(send).not.toHaveBeenCalled();
    h.stop();
  });

  it("resumes on visibility-change to visible", () => {
    const send = vi.fn();
    let visible = false;
    const visListener: { cb: (() => void) | null } = { cb: null };
    const h = startPreviewKeepalive({
      appDirectory: "a",
      port: 4000,
      send,
      isVisible: () => visible,
      onVisibilityChange: (cb) => { visListener.cb = cb; return () => { visListener.cb = null; }; },
      now: () => 5000,
    });
    expect(send).not.toHaveBeenCalled();
    visible = true;
    visListener.cb?.();
    expect(send).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it("stop() prevents further sends", () => {
    const send = vi.fn();
    const h = startPreviewKeepalive({
      appDirectory: "a",
      port: 4000,
      send,
      isVisible: () => true,
      onVisibilityChange: () => () => {},
    });
    h.stop();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
