import { isFullTimeEmployee, type EmployeeClassificationFields } from "./employee-classification.ts";

export type EmployeeDeleteActor = {
  role?: unknown;
  storeId?: unknown;
};

export type DeletableEmployee = EmployeeClassificationFields & {
  storeId?: string | null;
};

export function authorizeEmployeeDeletion(actor: EmployeeDeleteActor, employee: DeletableEmployee): { allowed: true } | { allowed: false; status: 403; error: string } {
  if (isFullTimeEmployee(employee)) return { allowed: false, status: 403, error: "正社員はアルバイト画面から削除できません。" };
  if (actor.role === "admin") return { allowed: true };
  if (actor.role === "manager" && typeof actor.storeId === "string" && actor.storeId && actor.storeId === employee.storeId) return { allowed: true };
  return { allowed: false, status: 403, error: "この従業員を削除する権限がありません。" };
}
