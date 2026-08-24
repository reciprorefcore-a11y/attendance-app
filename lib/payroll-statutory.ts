export type StatutoryPayrollInput = {
  taxableEarnings: number;
  socialInsuranceEnrolled?: boolean | null;
  standardMonthlyRemuneration?: number | null;
  careInsuranceApplicable?: boolean | null;
  employmentInsuranceEnrolled?: boolean | null;
};

// 2026年8月・協会けんぽ神奈川の現行マスター移行用。標準報酬と加入状態が
// 明示されない限り推測計算しない。
export function calculateAutomaticStatutoryDeductions(input: StatutoryPayrollInput) {
  const standard = Number(input.standardMonthlyRemuneration);
  const canCalculateSocial = input.socialInsuranceEnrolled === true && Number.isInteger(standard) && standard > 0;
  const healthInsurance = canCalculateSocial ? Math.round(standard * 0.0992 / 2) : input.socialInsuranceEnrolled === false ? 0 : null;
  const childSupportContribution = canCalculateSocial ? Math.round(standard * 0.0023 / 2) : input.socialInsuranceEnrolled === false ? 0 : null;
  const careInsurance = canCalculateSocial ? (input.careInsuranceApplicable === true ? Math.round(standard * 0.0162 / 2) : input.careInsuranceApplicable === false ? 0 : null) : input.socialInsuranceEnrolled === false ? 0 : null;
  const employeePension = canCalculateSocial ? Math.round(standard * 0.183 / 2) : input.socialInsuranceEnrolled === false ? 0 : null;
  const employmentInsurance = input.employmentInsuranceEnrolled === true ? Math.round(Math.max(0, input.taxableEarnings) * 0.005) : input.employmentInsuranceEnrolled === false ? 0 : null;
  const socialInsuranceTotal = [healthInsurance, childSupportContribution, careInsurance, employeePension, employmentInsurance].every((value) => value != null)
    ? [healthInsurance, childSupportContribution, careInsurance, employeePension, employmentInsurance].reduce<number>((sum, value) => sum + Number(value), 0) : null;
  return { healthInsurance, childSupportContribution, careInsurance, employeePension, employmentInsurance, socialInsuranceTotal };
}
