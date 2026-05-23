import { type NextRequest, NextResponse } from "next/server";
import { proxyToVps, getProxyPort, getLocalEnv } from "@/lib/local-proxy";

export async function GET(req: NextRequest) {
  const sid = req.nextUrl.searchParams.get("_code_session");
  if (!sid) return NextResponse.json({ error: "missing _code_session" }, { status: 400 });
  if (!getLocalEnv().secret && !getProxyPort()) return NextResponse.json({ error: "not in local mode" }, { status: 400 });
  return proxyToVps(req, `/_auth/code/establish?_code_session=${encodeURIComponent(sid)}`, { stripCookiePrefix: true });
}
