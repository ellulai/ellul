import { type NextRequest, NextResponse } from "next/server";
import { proxyToVps } from "@/lib/local-proxy";

async function proxy(req: NextRequest) {
  const rawP = req.nextUrl.searchParams.get("p");
  if (!rawP) return NextResponse.json({ error: "Missing ?p= param" }, { status: 400 });

  const [upstreamPath = "", embeddedQs] = rawP.split("?", 2);
  const qs = new URLSearchParams(req.nextUrl.searchParams);
  qs.delete("p");
  if (embeddedQs) {
    for (const [k, v] of new URLSearchParams(embeddedQs)) qs.set(k, v);
  }
  const extra = qs.toString();
  const path = `/${upstreamPath.replace(/^\//, "")}${extra ? `?${extra}` : ""}`;
  return proxyToVps(req, path, { stripCookiePrefix: true, purpose: "internal" });
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
