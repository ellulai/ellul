import { type NextRequest } from "next/server";
import { proxyToVps } from "@/lib/local-proxy";

async function proxy(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;
  return proxyToVps(req, `/${path.join("/")}`, { purpose: "internal" });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
