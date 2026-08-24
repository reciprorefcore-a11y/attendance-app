import { NextRequest, NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/firebase-admin";

export const runtime = "nodejs";

type EmployeeMatch = {
  id: string;
  employeeCode: string;
  name: string;
  nameKana: string;
  status: string;
  matchedBy: string[];
};

export async function GET(request: NextRequest) {
  const admin = await verifyAdminToken(request.headers.get("authorization"));
  if (!admin) return NextResponse.json({ error: "本部管理者権限が必要です" }, { status: 403 });

  const params = request.nextUrl.searchParams;
  const employeeCode = params.get("employeeCode") ?? "";
  const name = params.get("name") ?? "";
  const nameKana = params.get("nameKana") ?? "";

  if (!employeeCode && !name && !nameKana) {
    return NextResponse.json({ error: "検索条件を指定してください" }, { status: 400 });
  }

  const { db } = admin;
  const found = new Map<string, EmployeeMatch>();

  async function search(field: string, value: string) {
    if (!value) return;
    const snap = await db.collection("employees").where(field, "==", value).get();
    for (const d of snap.docs) {
      const data = d.data();
      const existing = found.get(d.id);
      if (existing) {
        existing.matchedBy.push(field);
      } else {
        found.set(d.id, {
          id: d.id,
          employeeCode: String(data.employeeCode ?? ""),
          name: String(data.name ?? ""),
          nameKana: String(data.nameKana ?? ""),
          status: String(data.status ?? ""),
          matchedBy: [field],
        });
      }
    }
  }

  await Promise.all([
    search("employeeCode", employeeCode),
    search("name", name),
    search("nameKana", nameKana),
  ]);

  return NextResponse.json({ results: [...found.values()] });
}
