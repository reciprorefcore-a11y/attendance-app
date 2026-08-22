import { NextResponse } from "next/server";
import { payrollPreviewHealth } from "@/lib/payroll-preview";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json(payrollPreviewHealth(), {
    headers: { "Cache-Control": "no-store" },
  });
}
