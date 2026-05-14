// SPDX-License-Identifier: MIT
// Copyright (c) 2025 ellul.ai. All rights reserved.

/**
 * `useIntegrations` hook tests.
 *
 * Uses @testing-library/react's `renderHook` against a stubbed `fetch`.
 * Covers: null project, successful fetch, error, refetch, project switch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { IntegrationsResponse } from "@ellul.ai/types";
import { useIntegrations } from "./useIntegrations";

function mkResponse(
  override?: Partial<IntegrationsResponse>,
): IntegrationsResponse {
  return {
    appName: "sbx-abc1234/my-app",
    state: {
      deployProviders: ["vercel"],
      dataProviders: [],
      gitProviders: ["github"],
      cloudflareProviders: [],
      paymentProviders: [],
      hasLinkedRepo: true,
      hasDeployConfig: true,
      hasDatabase: false,
      hasMigrations: false,
    },
    connections: {
      deploy: [],
      data: [],
      git: [],
      cloudflare: [],
      payments: [],
    },
    computedAt: 1,
    ...override,
  };
}

describe("useIntegrations", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not fetch when project is null", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useIntegrations(null));
    expect(result.current.data).toBeNull();
    expect(result.current.resolvedActions).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches and resolves available actions when a project is supplied", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        new Response(JSON.stringify(mkResponse()), { status: 200 }),
      ),
    );

    const { result } = renderHook(() =>
      useIntegrations("sbx-abc1234/my-app"),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data?.state.gitProviders).toEqual(["github"]);
    const ids = result.current.resolvedActions.map((a) => a.id).sort();
    expect(ids).toEqual(["deploy", "git-push"]);
  });

  it("returns an empty action list on fetch error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        new Response("no", { status: 500 }),
      ),
    );

    const { result } = renderHook(() =>
      useIntegrations("sbx-abc1234/my-app"),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/500/);
    expect(result.current.resolvedActions).toEqual([]);
  });

  it("re-fetches when refetch() is called", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify(mkResponse()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useIntegrations("sbx-abc1234/my-app"),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("revalidates on window focus, online, and visibilitychange", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify(mkResponse()), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() =>
      useIntegrations("sbx-abc1234/my-app"),
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // jsdom doesn't flip visibilityState on its own; simulate with a defineProperty.
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  });

  it("abandons stale responses after a project switch", async () => {
    let resolveFirst: ((r: Response) => void) | undefined;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("first-app")) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(
        new Response(
          JSON.stringify(
            mkResponse({
              state: {
                deployProviders: [],
                dataProviders: [],
                gitProviders: [],
                cloudflareProviders: [],
                paymentProviders: [],
                hasLinkedRepo: false,
                hasDeployConfig: false,
                hasDatabase: false,
                hasMigrations: false,
              },
            }),
          ),
          { status: 200 },
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ project }: { project: string | null }) => useIntegrations(project),
      { initialProps: { project: "sbx-abc1234/first-app" } },
    );
    // Switch before the first request resolves.
    rerender({ project: "sbx-abc1234/second-app" });
    // Now resolve the abandoned first response.
    resolveFirst?.(
      new Response(JSON.stringify(mkResponse()), { status: 200 }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    // The first response had deploy+git-push available; the second had none.
    // After the switch the second response wins.
    expect(result.current.resolvedActions).toEqual([]);
  });
});
