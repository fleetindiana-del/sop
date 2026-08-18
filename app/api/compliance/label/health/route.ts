import { NextResponse } from "next/server";
import { geminiLabelModel } from "@/lib/label-compliance/http";

export const dynamic = "force-dynamic";

/** Public health check so the UI can show whether Gemini is configured. */
export async function GET() {
  const configured = Boolean(process.env.GEMINI_API_KEY?.trim());
  return NextResponse.json({
    ok: configured,
    gemini: configured,
    model: configured ? geminiLabelModel() : null,
  });
}
