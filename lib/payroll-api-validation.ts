/**
 * API境界でのリクエスト入力検証。
 * Next.js依存なし・pure function のためユニットテスト可能。
 */

export type AdjValidationError = { status: 400; error: string };

/** adjustments オブジェクト全体を検証し、不正な場合はエラーを返す。正常なら null。 */
export function validateAdjustments(adjustments: unknown): AdjValidationError | null {
  if (adjustments === undefined || adjustments === null) return null;
  if (typeof adjustments !== "object" || Array.isArray(adjustments)) {
    return { status: 400, error: "adjustmentsはオブジェクトで指定してください" };
  }
  for (const [id, adj] of Object.entries(adjustments as Record<string, unknown>)) {
    if (!adj || typeof adj !== "object" || Array.isArray(adj)) {
      return { status: 400, error: `adjustmentsの値はオブジェクトで指定してください（社員ID: ${id}）` };
    }
    const val = (adj as Record<string, unknown>).expenseReimbursement;
    const attendanceCount = (adj as Record<string, unknown>).temporaryAttendanceCount;
    if (attendanceCount !== undefined && attendanceCount !== null && (typeof attendanceCount !== "number" || !Number.isFinite(attendanceCount) || attendanceCount < 0 || !Number.isInteger(attendanceCount))) {
      return { status: 400, error: `休日出勤回数は0以上の整数で入力してください（社員ID: ${id}）` };
    }
    if (val !== undefined && val !== null) {
      // 文字列や非数値型は JSON API では数値型として送信しなければならない
      if (typeof val !== "number") {
        return { status: 400, error: `立替経費精算は数値で入力してください（社員ID: ${id}）` };
      }
      if (!Number.isFinite(val) || val < 0 || Math.trunc(val) !== val) {
        return { status: 400, error: `立替経費精算は0以上の整数で入力してください（社員ID: ${id}）` };
      }
    }
    const holidayOverride = (adj as Record<string, unknown>).holidayAllowanceOverride;
    if (holidayOverride !== undefined && holidayOverride !== null && (typeof holidayOverride !== "number" || !Number.isFinite(holidayOverride) || holidayOverride < 0 || !Number.isInteger(holidayOverride))) {
      return { status: 400, error: `休日手当修正額は0以上の整数で入力してください（社員ID: ${id}）` };
    }
    const overrideReason = (adj as Record<string, unknown>).overrideReason;
    if (overrideReason !== undefined && typeof overrideReason !== "string") {
      return { status: 400, error: `休日手当修正理由は文字列で入力してください（社員ID: ${id}）` };
    }
  }
  return null;
}
