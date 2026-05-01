import { NextRequest, NextResponse } from "next/server";
import { getAdminAuth } from "@/lib/firebase-admin";

export async function POST(request: NextRequest) {
  const adminAuth = getAdminAuth();
  if (!adminAuth) {
    return NextResponse.json({ error: "ADMIN_SDK_NOT_CONFIGURED" }, { status: 501 });
  }

  const authHeader = request.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await adminAuth.verifyIdToken(authHeader.slice(7));
  } catch {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const body = await request.json() as { uid?: string };
  if (!body.uid) {
    return NextResponse.json({ error: "uid required" }, { status: 400 });
  }

  try {
    await adminAuth.deleteUser(body.uid);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("delete auth user failed", err);
    return NextResponse.json({ error: "Failed to delete auth user" }, { status: 500 });
  }
}
