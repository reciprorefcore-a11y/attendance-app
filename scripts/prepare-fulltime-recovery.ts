import { mkdirSync, writeFileSync } from "node:fs";

const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;
const outputDir = process.argv[2] ?? "/private/tmp/attendance-app-fulltime-recovery-2026-08-24";

if (!projectId || !apiKey) throw new Error("Firebase public configuration is missing");

type FirestoreValue = Record<string, unknown>;
type FirestoreDocument = { name: string; fields?: Record<string, FirestoreValue>; createTime?: string; updateTime?: string };

function decode(value: FirestoreValue): unknown {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("stringValue" in value) return value.stringValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("arrayValue" in value) return ((value.arrayValue as { values?: FirestoreValue[] }).values ?? []).map(decode);
  if ("mapValue" in value) {
    return Object.fromEntries(Object.entries((value.mapValue as { fields?: Record<string, FirestoreValue> }).fields ?? {}).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}

function decodeDocument(document: FirestoreDocument) {
  return {
    path: document.name.split("/documents/")[1],
    fields: Object.fromEntries(Object.entries(document.fields ?? {}).map(([key, value]) => [key, decode(value)])),
    createTime: document.createTime,
    updateTime: document.updateTime,
  };
}

async function getDocument(path: string, idToken?: string) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?key=${apiKey}`;
  const response = await fetch(url, { headers: idToken ? { Authorization: `Bearer ${idToken}` } : undefined });
  if (response.status === 404) return { exists: false as const, path };
  if (!response.ok) return { exists: null, path, status: response.status, error: await response.text() };
  return { exists: true as const, ...decodeDocument(await response.json() as FirestoreDocument) };
}

async function listCollection(path: string) {
  const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/${path}?pageSize=1000&key=${apiKey}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
  const body = await response.json() as { documents?: FirestoreDocument[] };
  return (body.documents ?? []).map(decodeDocument);
}

const existingIds = {
  "0003": "hvjU14BKDB0pCdDrUZF1",
  "0064": "c6ADSFHwyHecwScuZ6g8",
  "0083": "zbpOikyklko5CL6G6Yon",
} as const;
const plannedNewIds = { "0002": "8gPG2ASRkf52GLednUL3", "0017": "GHs3TOpfNsTb2cVHFpoQ" } as const;

const employeeBackups = await Promise.all(Object.values(existingIds).map((id) => getDocument(`employees/${id}`)));
const plannedPathChecks = await Promise.all(Object.values(plannedNewIds).flatMap((id) => [getDocument(`employees/${id}`), getDocument(`payrollSettings/${id}`)]));
const allEmployees = await listCollection("employees");
const targetIdentities = [
  { employeeCode: "0002", names: ["青山佳史", "青山　佳史"] },
  { employeeCode: "0003", names: ["中村鏡太郎", "中村　鏡太郎"] },
  { employeeCode: "0017", names: ["木月徳子", "木月　徳子"] },
  { employeeCode: "0064", names: ["小林彗太", "小林　彗太"] },
  { employeeCode: "0083", names: ["佐藤雅信", "佐藤　雅信"] },
];
const identityAudit = targetIdentities.map((target) => ({
  employeeCode: target.employeeCode,
  matches: allEmployees.filter((document) => {
    const fields = document.fields as Record<string, unknown>;
    return String(fields.employeeCode ?? "").padStart(4, "0") === target.employeeCode || target.names.includes(String(fields.name ?? ""));
  }).map((document) => ({ path: document.path, employeeCode: (document.fields as Record<string, unknown>).employeeCode, name: (document.fields as Record<string, unknown>).name, isDeleted: (document.fields as Record<string, unknown>).isDeleted })),
}));
const idToken = process.env.FIREBASE_ADMIN_ID_TOKEN;
const payrollSettings = idToken
  ? await Promise.all(Object.values(existingIds).map((id) => getDocument(`payrollSettings/${id}`, idToken)))
  : Object.values(existingIds).map((id) => ({ exists: null, path: `payrollSettings/${id}`, status: "unconfirmed", error: "FIREBASE_ADMIN_ID_TOKEN was not supplied; no unauthenticated read was attempted" }));

const commonRestore = {
  isDeleted: false,
  employeeType: "fullTime",
  employmentType: "full_time",
  payrollType: "fixed",
  payrollEnabled: true,
  clockEnabled: false,
  status: "active",
};

const existingPlans = Object.entries(existingIds).map(([employeeCode, id]) => {
  const backup = employeeBackups.find((item) => item.path === `employees/${id}`);
  const fields = backup && "fields" in backup ? backup.fields as Record<string, unknown> : {};
  return {
    employeeCode,
    documentPath: `employees/${id}`,
    operation: "update fields only (no delete and no payrollSettings write)",
    updatePayload: commonRestore,
    preserveUnchanged: employeeCode === "0003"
      ? ["hasManagerAccount", "managerUid", "accountRole", "accountStoreIds"]
      : [],
    removalCandidatesNotApplied: Object.fromEntries(
      ["storeId", "storeName", "pin", "baseWage", "hourlyWage", "transportationCost", "transportationType"]
        .filter((key) => key in fields)
        .map((key) => [key, key === "pin" ? { present: true, value: "REDACTED_IN_PLAN_SEE_BACKUP" } : fields[key]]),
    ),
    payrollSettingsPath: `payrollSettings/${id}`,
    payrollSettingsOperation: "none until authenticated read and explicit approval",
  };
});

const newPlans = [
  {
    employeeCode: "0002",
    name: "青山佳史",
    employeeId: plannedNewIds["0002"],
    employeePath: `employees/${plannedNewIds["0002"]}`,
    payrollSettingsPath: `payrollSettings/${plannedNewIds["0002"]}`,
    employeePayload: { employeeCode: "0002", name: "青山佳史", nameKana: "あおやま よしふみ", ...commonRestore, createdAt: "serverTimestamp()", updatedAt: "serverTimestamp()" },
    payrollSettingsPayload: {
      fixedBaseSalary: 0, directorCompensation: 150000, positionAllowance: 0, businessAllowance: 0,
      holidayAllowance: 0, fixedOvertimeAllowance: 0, healthInsurance: 7440, childSupportContribution: 172,
      careInsurance: 1215, employeePension: 13725, employmentInsurance: 0, residentTax: 12600,
      paymentMethod: "cash", residentTaxHistory: [{ amount: 12600, effectiveMonth: "2026-08", updatedAt: "serverTimestamp()", updatedBy: "CURRENT_ADMIN_UID" }],
      createdAt: "serverTimestamp()", updatedAt: "serverTimestamp()",
    },
    unresolved: { incomeTax: "未確定（給与計算で算出し固定保存しない）", bankAccount: "未確定（現金支給）" },
  },
  {
    employeeCode: "0017",
    name: "木月徳子",
    employeeId: plannedNewIds["0017"],
    employeePath: `employees/${plannedNewIds["0017"]}`,
    payrollSettingsPath: `payrollSettings/${plannedNewIds["0017"]}`,
    employeePayload: { employeeCode: "0017", name: "木月徳子", nameKana: "きづき のりこ", ...commonRestore, createdAt: "serverTimestamp()", updatedAt: "serverTimestamp()" },
    payrollSettingsPayload: {
      fixedBaseSalary: 200000, directorCompensation: 0, positionAllowance: 6000, businessAllowance: 0,
      holidayAllowance: 0, fixedOvertimeAllowance: 0, healthInsurance: 9920, childSupportContribution: 230,
      careInsurance: 1620, employeePension: 18300, employmentInsurance: 1030, residentTax: 0,
      paymentMethod: "bank", residentTaxHistory: [{ amount: 0, effectiveMonth: "2026-08", updatedAt: "serverTimestamp()", updatedBy: "CURRENT_ADMIN_UID" }],
      createdAt: "serverTimestamp()", updatedAt: "serverTimestamp()",
    },
    unresolved: { incomeTax: "3,410円を今回計算で維持し固定保存しない", bankAccount: "未確定" },
  },
];

mkdirSync(outputDir, { recursive: true });
writeFileSync(`${outputDir}/employees-before.json`, JSON.stringify({ readOnlyAt: new Date().toISOString(), documents: employeeBackups }, null, 2));
writeFileSync(`${outputDir}/employee-identity-audit.json`, JSON.stringify({ readOnlyAt: new Date().toISOString(), targets: identityAudit }, null, 2));
writeFileSync(`${outputDir}/payroll-settings-before.json`, JSON.stringify({ readOnlyAt: new Date().toISOString(), documents: payrollSettings }, null, 2));
writeFileSync(`${outputDir}/recovery-plan.json`, JSON.stringify({ generatedAt: new Date().toISOString(), firestoreWritesPerformed: false, plannedPathChecks, existingPlans, newPlans }, null, 2));
console.log(JSON.stringify({ outputDir, employees: employeeBackups.map((item) => ({ path: item.path, exists: item.exists })), identityAudit, plannedPathChecks: plannedPathChecks.map((item) => ({ path: item.path, exists: item.exists })), payrollSettings: payrollSettings.map((item) => ({ path: item.path, exists: item.exists, status: "status" in item ? item.status : undefined })), firestoreWritesPerformed: false }, null, 2));
