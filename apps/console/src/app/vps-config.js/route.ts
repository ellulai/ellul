import { NextResponse } from "next/server";
import { localEllulConfig } from "@/lib/local-proxy";

export function GET() {
  if (!process.env.LOCAL_PROXY_PORT) {
    return new NextResponse("// not in local mode", {
      headers: { "Content-Type": "application/javascript" },
    });
  }
  const js = `window.__ELLUL_CONFIG__=${JSON.stringify(localEllulConfig("http://localhost:3000"))};`;
  return new NextResponse(js, {
    headers: { "Content-Type": "application/javascript", "Cache-Control": "no-store" },
  });
}
