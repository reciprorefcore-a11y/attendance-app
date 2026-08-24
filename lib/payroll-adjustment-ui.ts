import { calculateHolidayUnitPay, type FixedPayrollAdjustment } from "./payroll.ts";

export type HolidayBasisSource = {
  holidayAllowanceBaseSalary?: number | null;
  fixedBaseSalary?: number | null;
};

export function resolveHolidayAllowanceBasis(source: HolidayBasisSource): number | null {
  const base = Number(source.fixedBaseSalary);
  if (Number.isFinite(base) && base > 0) return base;
  return null;
}

export function holidayAllowancePreview(source: HolidayBasisSource, count: number) {
  const basis = resolveHolidayAllowanceBasis(source);
  const validCount = Number.isInteger(count) && count >= 0;
  const unitPay = basis == null ? null : calculateHolidayUnitPay(basis);
  return { basis, unitPay, automaticAllowance: unitPay == null || !validCount ? null : unitPay * count };
}

export function adjustmentDisabledReason(input: {
  selected: boolean;
  adjustment: FixedPayrollAdjustment;
  holidayBasis: number | null;
  manualHolidayOverride: boolean;
  busy: boolean;
}): string | null {
  if (!input.selected) return "正社員を選択してください";
  const count = input.adjustment.temporaryAttendanceCount ?? 0;
  if (!Number.isInteger(count) || count < 0) return "休日出勤回数は0以上の整数で入力してください";
  if (count > 0 && input.holidayBasis == null) return "正社員マスターで休日手当算定基礎を設定してください";
  if (input.manualHolidayOverride) {
    const amount = input.adjustment.holidayAllowanceOverride;
    if (amount == null || !Number.isInteger(amount) || amount < 0) return "休日出勤手当の修正後金額は0以上の整数で入力してください";
    if (!input.adjustment.overrideReason?.trim()) return "休日出勤手当を手動修正する場合は、修正理由を入力してください";
  }
  const reimbursement = input.adjustment.expenseReimbursement ?? 0;
  if (!Number.isInteger(reimbursement) || reimbursement < 0) return "立替経費精算は0以上の整数で入力してください";
  if (input.busy) return "再試算処理中です";
  return null;
}

export function reimbursementPending(inputAmount: number, appliedAmount: number): boolean {
  return inputAmount !== appliedAmount;
}
