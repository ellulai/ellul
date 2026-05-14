import type { AppType } from "@ellul.ai/api/client";
import { hc } from "hono/client";
type _Verify = ReturnType<typeof hc<AppType>>;
export type { AppType };
export declare function createApiClient(baseUrl: string, options?: RequestInit): ReturnType<typeof hc<AppType>>;
