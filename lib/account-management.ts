export const ACCOUNT_ROLES = ["admin", "area_manager", "fc_manager", "manager"] as const;
export type AccountRole = typeof ACCOUNT_ROLES[number];

export const ACCOUNT_ROLE_LABELS: Record<AccountRole | "staff", string> = {
  admin: "本部管理者",
  area_manager: "エリアマネージャー",
  fc_manager: "FCマネージャー",
  manager: "店舗マネージャー",
  staff: "一般スタッフ",
};

export function isHeadquartersAdmin(profile: { role?: unknown } | null | undefined) {
  return profile?.role === "admin" || profile?.role === "hq_admin";
}

export function sanitizeAccountRecord(uid: string, data: Record<string, unknown>) {
  return {
    uid,
    name: String(data.name ?? ""),
    email: String(data.email ?? ""),
    role: String(data.role ?? ""),
    storeId: String(data.storeId ?? ""),
    storeIds: Array.isArray(data.storeIds) ? data.storeIds.map(String) : [],
    status: data.status === "inactive" || data.isActive === false ? "inactive" : "active",
    lastLoginAt: data.lastLoginAt ?? null,
    employeeId: typeof data.employeeId === "string" ? data.employeeId : null,
  };
}

export function accountChanges(before: Record<string, unknown>, after: Record<string, unknown>) {
  return Object.entries(after)
    .filter(([field, value]) => field !== "password" && field !== "initialPassword" && before[field] !== value)
    .map(([field, value]) => ({ field, before: before[field] ?? null, after: value ?? null }));
}
