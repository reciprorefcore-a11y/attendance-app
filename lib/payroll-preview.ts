export function isPayrollPreviewReadOnly() {
  return process.env.VERCEL_ENV === "preview" && process.env.PAYROLL_PREVIEW_READ_ONLY === "true";
}

export function rejectPayrollPreviewWrite() {
  if (!isPayrollPreviewReadOnly()) return null;
  return { error: "Preview環境は読み取り専用です。書き込み操作は実行できません" };
}

export function payrollPreviewHealth() {
  let serviceAccountProjectMatches = false;
  let serviceAccountJsonValid = false;
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON ?? "") as { project_id?: string };
    serviceAccountJsonValid = true;
    serviceAccountProjectMatches = serviceAccount.project_id === "fublev-attendance";
  } catch {
    // Report booleans only. Never return the credential or its fields.
  }
  return {
    preview: process.env.VERCEL_ENV === "preview",
    readOnly: isPayrollPreviewReadOnly(),
    serviceAccountConfigured: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
    serviceAccountJsonValid,
    serviceAccountProjectMatches,
  };
}
