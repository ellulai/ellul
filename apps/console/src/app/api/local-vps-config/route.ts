import { NextResponse } from "next/server";
import { localEllulConfig } from "@/lib/local-proxy";

const ORIGIN = process.env.NEXT_PUBLIC_WEB_URL || "http://localhost:3000";
const JS = `window.__ELLUL_CONFIG__=${JSON.stringify(localEllulConfig(ORIGIN))};`;

export function GET() {
  return new NextResponse(JS, {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" },
  });
}
