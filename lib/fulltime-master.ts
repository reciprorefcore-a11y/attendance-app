import { isFullTimeEmployee, type EmployeeClassificationFields } from "./employee-classification.ts";

export type FullTimeMasterRecord = EmployeeClassificationFields & { status?: string | null; isActive?: boolean | null };
export const isActiveFullTimeMaster = (employee: FullTimeMasterRecord) => employee.employmentType === "full_time" && employee.isDeleted !== true && employee.status !== "inactive" && employee.isActive !== false;
export const isInactiveFullTimeMaster = (employee: FullTimeMasterRecord) => isFullTimeEmployee(employee) && !isActiveFullTimeMaster(employee);

export type FullTimeMasterInput = {
  name: string; employeeCode: string; nameKana?: string; storeId?: string; storeName?: string;
  fixedBaseSalary: number; transportationType: "none" | "daily" | "monthly"; transportationAmount: number;
  residentTax: number; dependentCount: number; taxTableType: "kou" | "otsu";
  socialInsuranceEnrolled: boolean; standardMonthlyRemuneration: number;
  careInsuranceApplicable: boolean; employmentInsuranceEnrolled: boolean;
  effectiveMonth: string;
};

export function validateFullTimeMasterInput(value: FullTimeMasterInput) {
  const errors: string[] = [];
  if (!value.name?.trim() || !value.employeeCode?.trim()) errors.push("氏名と社員コードは必須です");
  if (!/^\d{4}-\d{2}$/.test(value.effectiveMonth)) errors.push("適用開始月が不正です");
  for (const [label, amount] of [["月給", value.fixedBaseSalary], ["交通費", value.transportationAmount], ["住民税", value.residentTax], ["扶養人数", value.dependentCount], ["標準報酬月額", value.standardMonthlyRemuneration]] as const) if (!Number.isInteger(amount) || amount < 0) errors.push(`${label}は0以上の整数で入力してください`);
  if (!['none','daily','monthly'].includes(value.transportationType)) errors.push("交通費区分が不正です");
  if (!['kou','otsu'].includes(value.taxTableType)) errors.push("甲欄・乙欄が不正です");
  if (value.socialInsuranceEnrolled && value.standardMonthlyRemuneration <= 0) errors.push("社会保険加入者は標準報酬月額が必要です");
  return errors;
}

export function upsertEffectiveHistory<T extends { effectiveMonth: string }>(history: T[] | undefined, entry: T): T[] {
  return [...(Array.isArray(history) ? history.filter((item) => item?.effectiveMonth !== entry.effectiveMonth) : []), entry].sort((a,b) => a.effectiveMonth.localeCompare(b.effectiveMonth));
}
