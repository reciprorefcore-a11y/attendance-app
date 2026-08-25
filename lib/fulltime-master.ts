import { isFullTimeEmployee, type EmployeeClassificationFields } from "./employee-classification.ts";

export type FullTimeMasterRecord = EmployeeClassificationFields & { status?: string | null; isActive?: boolean | null };
export const isActiveFullTimeMaster = (employee: FullTimeMasterRecord) => employee.employmentType === "full_time" && employee.isDeleted !== true && employee.status !== "inactive" && employee.isActive !== false;
export const isInactiveFullTimeMaster = (employee: FullTimeMasterRecord) => isFullTimeEmployee(employee) && !isActiveFullTimeMaster(employee);

export type FullTimeMasterInput = {
  name: string; employeeCode: string; nameKana?: string; storeId?: string; storeName?: string;
  fixedBaseSalary: number; directorCompensation: number; positionAllowance: number; skillAllowance: number;
  fixedOvertimeAllowance: number; fixedOvertimeSupplement: number; fixedOvertimeHours: number | null; otherFixedAllowance: number; otherFixedAllowanceName: string;
  transportationType: "none" | "daily" | "monthly"; transportationAmount: number;
  residentTax: number; dependentCount: number; taxTableType: "kou" | "otsu";
  socialInsuranceEnrolled: boolean; standardMonthlyRemuneration: number;
  careInsuranceApplicable: boolean; employmentInsuranceEnrolled: boolean;
  effectiveMonth: string; reason: string;
};

export type FixedSalaryBreakdown = Pick<FullTimeMasterInput, "fixedBaseSalary" | "directorCompensation" | "positionAllowance" | "skillAllowance" | "fixedOvertimeAllowance" | "fixedOvertimeSupplement" | "fixedOvertimeHours" | "otherFixedAllowance" | "otherFixedAllowanceName">;

export const calculateTotalFixedSalary = (value: FixedSalaryBreakdown) =>
  value.fixedBaseSalary + value.directorCompensation + value.positionAllowance + value.skillAllowance + value.fixedOvertimeAllowance + value.fixedOvertimeSupplement + value.otherFixedAllowance;

export function migrateLegacyFixedSalary(value: Partial<FixedSalaryBreakdown> & { businessAllowance?: number | null }): FixedSalaryBreakdown {
  const legacyBusiness = Math.max(0, Math.trunc(Number(value.businessAllowance) || 0));
  const legacyFixedOvertime = Math.max(0, Math.trunc(Number(value.fixedOvertimeAllowance) || 0));
  const explicitOther = Math.max(0, Math.trunc(Number(value.otherFixedAllowance) || 0));
  const isNewBreakdown = value.skillAllowance != null || value.fixedOvertimeSupplement != null;
  return {
    fixedBaseSalary: Math.max(0, Math.trunc(Number(value.fixedBaseSalary) || 0)),
    directorCompensation: Math.max(0, Math.trunc(Number(value.directorCompensation) || 0)),
    // 旧positionAllowanceは過去帳票上「職能手当」。新形式だけpositionAllowanceを役職手当として扱う。
    positionAllowance: isNewBreakdown ? Math.max(0, Math.trunc(Number(value.positionAllowance) || 0)) : 0,
    skillAllowance: isNewBreakdown ? Math.max(0, Math.trunc(Number(value.skillAllowance) || 0)) : Math.max(0, Math.trunc(Number(value.positionAllowance) || 0)),
    // 新フィールドが明示済みなら優先。旧businessAllowanceは固定残業手当候補として一度だけ移行する。
    fixedOvertimeAllowance: legacyBusiness > 0 ? legacyBusiness : legacyFixedOvertime,
    // 旧fixedOvertimeAllowanceは過去帳票の独立した「残業手当」。その他手当へ移さない。
    fixedOvertimeSupplement: Math.max(0, Math.trunc(Number(value.fixedOvertimeSupplement) || (legacyBusiness > 0 ? legacyFixedOvertime : 0))),
    fixedOvertimeHours: Number.isFinite(value.fixedOvertimeHours) && Number(value.fixedOvertimeHours) >= 0 ? Number(value.fixedOvertimeHours) : null,
    otherFixedAllowance: explicitOther,
    otherFixedAllowanceName: String(value.otherFixedAllowanceName ?? ""),
  };
}

export function validateFullTimeMasterInput(value: FullTimeMasterInput) {
  const errors: string[] = [];
  if (!value.name?.trim() || !value.employeeCode?.trim()) errors.push("氏名と社員コードは必須です");
  if (!/^\d{4}-\d{2}$/.test(value.effectiveMonth)) errors.push("適用開始月が不正です");
  if (!value.reason?.trim()) errors.push("固定給与内訳の変更理由は必須です");
  for (const [label, amount] of [["基本給", value.fixedBaseSalary], ["役員報酬", value.directorCompensation], ["役職手当", value.positionAllowance], ["職能手当", value.skillAllowance], ["業務手当（固定残業）", value.fixedOvertimeAllowance], ["固定残業手当（別枠）", value.fixedOvertimeSupplement], ["その他固定手当", value.otherFixedAllowance], ["交通費", value.transportationAmount], ["住民税", value.residentTax], ["扶養人数", value.dependentCount], ["標準報酬月額", value.standardMonthlyRemuneration]] as const) if (!Number.isInteger(amount) || amount < 0) errors.push(`${label}は0以上の整数で入力してください`);
  if (value.fixedOvertimeHours != null && (!Number.isFinite(value.fixedOvertimeHours) || value.fixedOvertimeHours < 0)) errors.push("固定残業時間は0以上で入力してください");
  if (value.otherFixedAllowance > 0 && !value.otherFixedAllowanceName.trim()) errors.push("その他固定手当の名称は必須です");
  if (!['none','daily','monthly'].includes(value.transportationType)) errors.push("交通費区分が不正です");
  if (!['kou','otsu'].includes(value.taxTableType)) errors.push("甲欄・乙欄が不正です");
  if (value.socialInsuranceEnrolled && value.standardMonthlyRemuneration <= 0) errors.push("社会保険加入者は標準報酬月額が必要です");
  return errors;
}

export type BaseUpHistoryEntry = { effectiveDate:"2026-05-01"; effectiveMonth:"2026-05"; firstPaymentDate:"2026-06-25"; careerUpPlanSubmittedAt:"2026-04-15"; previousFixedSalary:number; raiseRate:0.03; calculatedRaiseAmount:number; appliedRaiseAmount:number; applicationItem:"skillAllowance"; baseSalary:number; skillAllowance:number; positionAllowance:number; fixedOvertimeAllowance:number; fixedOvertimeSupplement:number; totalFixedSalary:number; reason:"キャリアアップ助成金対応による3％賃金引上げ"; updatedBy:string; updatedAt:unknown };
export function buildBaseUpHistoryPreview(input:{previousFixedSalary:number;previousSkillAllowance:number;breakdown:FixedSalaryBreakdown;updatedBy:string;updatedAt:unknown;isDirector?:boolean}):BaseUpHistoryEntry|null {
  if(input.isDirector)return null;
  const calculated=Math.round(input.previousFixedSalary*0.03*100)/100;
  return {effectiveDate:"2026-05-01",effectiveMonth:"2026-05",firstPaymentDate:"2026-06-25",careerUpPlanSubmittedAt:"2026-04-15",previousFixedSalary:input.previousFixedSalary,raiseRate:0.03,calculatedRaiseAmount:calculated,appliedRaiseAmount:input.breakdown.skillAllowance-input.previousSkillAllowance,applicationItem:"skillAllowance",baseSalary:input.breakdown.fixedBaseSalary,skillAllowance:input.breakdown.skillAllowance,positionAllowance:input.breakdown.positionAllowance,fixedOvertimeAllowance:input.breakdown.fixedOvertimeAllowance,fixedOvertimeSupplement:input.breakdown.fixedOvertimeSupplement,totalFixedSalary:calculateTotalFixedSalary(input.breakdown),reason:"キャリアアップ助成金対応による3％賃金引上げ",updatedBy:input.updatedBy,updatedAt:input.updatedAt};
}

export function upsertEffectiveHistory<T extends { effectiveMonth: string }>(history: T[] | undefined, entry: T): T[] {
  return [...(Array.isArray(history) ? history.filter((item) => item?.effectiveMonth !== entry.effectiveMonth) : []), entry].sort((a,b) => a.effectiveMonth.localeCompare(b.effectiveMonth));
}

export function resolveEffectiveHistory<T extends { effectiveMonth: string }>(history: T[] | undefined, targetMonth: string): T | null {
  return [...(Array.isArray(history) ? history : [])].filter((item)=>item?.effectiveMonth<=targetMonth).sort((a,b)=>b.effectiveMonth.localeCompare(a.effectiveMonth))[0] ?? null;
}
