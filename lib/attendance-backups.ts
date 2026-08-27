export type BackupType = "pitr" | "managed_export";
export type BackupStatus = "queued" | "running" | "succeeded" | "failed";
export type ProtectionState = "not_configured" | "enabled" | "disabled" | "unavailable" | "healthy" | "failed";
export type CandidateKind = "missing" | "changed" | "unchanged" | "duplicate_suspected" | "current_only";
export type RestoreEligibility = "restorable" | "review_required" | "excluded";

export type BackupRecord = {
  id: string;
  type: BackupType;
  status: BackupStatus;
  collection: "clockLogs";
  periodStart: string;
  periodEnd: string;
  count: number | null;
  destinationMasked: string;
  startedAt: string;
  completedAt: string | null;
  errorSummary: string | null;
};

export type PayrollOverlapWarning = { month: string; candidateIds: string[]; message: string };
export type ClockLogSnapshot = { id: string; data: Record<string, unknown> };
export type RestoreCandidate = {
  documentId: string;
  kind: CandidateKind;
  employeeId: string;
  employeeName: string;
  storeId: string;
  storeName: string;
  punchType: string;
  punchAt: string | null;
  historical: Record<string, unknown> | null;
  current: Record<string, unknown> | null;
  changedFields: string[];
  period: { start: string; end: string };
  payrollOverlapMonths: string[];
  eligibility: RestoreEligibility;
  selectedByDefault: boolean;
};
export type RestorePreviewRequest = {
  backupId: string;
  historical: ClockLogSnapshot[];
  current: ClockLogSnapshot[];
  storeIds?: string[];
  employeeIds?: string[];
  periodStart: string;
  periodEnd: string;
  confirmedPayrollMonths?: string[];
};
export type RestorePreviewResult = {
  previewId: string;
  currentStateHash: string;
  candidates: RestoreCandidate[];
  payrollWarnings: PayrollOverlapWarning[];
  ignoredComparisonFields: readonly ["updatedAt"];
};

export const IGNORED_COMPARISON_FIELDS = ["updatedAt"] as const;
const SECRET_FIELDS = /^(pin|password|passwordHash|token|accessToken|refreshToken|secret)$/i;

function timestamp(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string") { if(!/^\d{4}-\d{2}-\d{2}T/.test(value))return null;const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
  if (typeof value === "number") { const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date.toISOString(); }
  if (value && typeof value === "object") {
    const item = value as { seconds?: unknown; nanoseconds?: unknown; _seconds?: unknown; _nanoseconds?: unknown; toDate?: () => Date };
    if (typeof item.toDate === "function") return timestamp(item.toDate());
    const seconds = typeof item.seconds === "number" ? item.seconds : item._seconds;
    const nanos = typeof item.nanoseconds === "number" ? item.nanoseconds : item._nanoseconds;
    if (typeof seconds === "number") return new Date(seconds * 1000 + (typeof nanos === "number" ? nanos / 1e6 : 0)).toISOString();
  }
  return null;
}

export function normalizeBackupValue(value: unknown): unknown {
  const asTimestamp = timestamp(value);
  if (asTimestamp !== null) return asTimestamp;
  if (Array.isArray(value)) return value.map(normalizeBackupValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => !SECRET_FIELDS.test(key)).map(([key, item]) => [key, normalizeBackupValue(item)]));
  return value;
}

function sanitized(data: Record<string, unknown>) {
  return normalizeBackupValue(data) as Record<string, unknown>;
}
function comparable(data: Record<string, unknown>) {
  const clean = sanitized(data);
  for (const field of IGNORED_COMPARISON_FIELDS) delete clean[field];
  return clean;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
function hash(value: unknown) { let h = 2166136261; for (const c of stable(value)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16).padStart(8, "0"); }
function stringField(data: Record<string, unknown>, ...keys: string[]) { for (const key of keys) if (typeof data[key] === "string") return data[key] as string; return ""; }
function punchTime(data: Record<string, unknown>) { for (const key of ["timestamp", "punchedAt", "clockAt", "createdAt"]) { const result = timestamp(data[key]); if (result) return result; } return null; }
function monthOf(value: string | null) { return value?.slice(0, 7) ?? ""; }
function inScope(log: ClockLogSnapshot, request: RestorePreviewRequest) {
  const data=log.data, time=punchTime(data);
  if (!time || time < new Date(request.periodStart).toISOString() || time > new Date(request.periodEnd).toISOString()) return false;
  const store=stringField(data,"storeId","workStoreId"), employee=stringField(data,"employeeId","staffId");
  return (!request.storeIds?.length || request.storeIds.includes(store)) && (!request.employeeIds?.length || request.employeeIds.includes(employee));
}
function metadata(data: Record<string, unknown>) {
  return { employeeId:stringField(data,"employeeId","staffId"), employeeName:stringField(data,"employeeName","staffName","name"), storeId:stringField(data,"storeId","workStoreId"), storeName:stringField(data,"storeName","workStoreName"), punchType:stringField(data,"type","punchType"), punchAt:punchTime(data) };
}
function duplicateOf(historical: ClockLogSnapshot, current: ClockLogSnapshot, toleranceMs: number) {
  const a=metadata(historical.data),b=metadata(current.data);
  return a.employeeId!==""&&a.employeeId===b.employeeId&&a.storeId===b.storeId&&a.punchType===b.punchType&&!!a.punchAt&&!!b.punchAt&&Math.abs(Date.parse(a.punchAt)-Date.parse(b.punchAt))<=toleranceMs;
}
function changedFields(a: Record<string, unknown>, b: Record<string, unknown>) {
  const left=comparable(a),right=comparable(b); return [...new Set([...Object.keys(left),...Object.keys(right)])].filter(key=>stable(left[key])!==stable(right[key])).sort();
}

export function createRestorePreview(request: RestorePreviewRequest, duplicateToleranceMs=60_000): RestorePreviewResult {
  const historical=request.historical.filter(log=>inScope(log,request)),current=request.current.filter(log=>inScope(log,request));
  const oldById=new Map(historical.map(log=>[log.id,log])),nowById=new Map(current.map(log=>[log.id,log]));
  const candidates:RestoreCandidate[]=[];
  const add=(id:string,kind:CandidateKind,oldLog:ClockLogSnapshot|null,nowLog:ClockLogSnapshot|null)=>{
    const basis=(oldLog??nowLog)!.data,m=metadata(basis),overlap=(request.confirmedPayrollMonths??[]).filter(month=>month===monthOf(m.punchAt));
    const eligibility:RestoreEligibility=kind==="missing"?"restorable":kind==="changed"||kind==="duplicate_suspected"?"review_required":"excluded";
    candidates.push({documentId:id,kind,...m,historical:oldLog?sanitized(oldLog.data):null,current:nowLog?sanitized(nowLog.data):null,changedFields:oldLog&&nowLog?changedFields(oldLog.data,nowLog.data):[],period:{start:request.periodStart,end:request.periodEnd},payrollOverlapMonths:overlap,eligibility,selectedByDefault:kind==="missing"&&overlap.length===0});
  };
  for(const oldLog of historical){const now=nowById.get(oldLog.id);if(now)add(oldLog.id,changedFields(oldLog.data,now.data).length?"changed":"unchanged",oldLog,now);else{const dupe=current.find(item=>item.id!==oldLog.id&&duplicateOf(oldLog,item,duplicateToleranceMs));add(oldLog.id,dupe?"duplicate_suspected":"missing",oldLog,dupe??null);}}
  for(const now of current)if(!oldById.has(now.id)&&!historical.some(old=>duplicateOf(old,now,duplicateToleranceMs)))add(now.id,"current_only",null,now);
  candidates.sort((a,b)=>a.documentId.localeCompare(b.documentId));
  const payrollWarnings=[...new Set(candidates.flatMap(c=>c.payrollOverlapMonths))].map(month=>({month,candidateIds:candidates.filter(c=>c.payrollOverlapMonths.includes(month)).map(c=>c.documentId),message:`${month} は確定済み給与月です。給与は自動再計算されません。`}));
  const currentStateHash=hash(current.map(log=>({id:log.id,data:comparable(log.data)})).sort((a,b)=>a.id.localeCompare(b.id)));
  return {previewId:`preview-${hash({backupId:request.backupId,currentStateHash,candidates})}`,currentStateHash,candidates,payrollWarnings,ignoredComparisonFields:IGNORED_COMPARISON_FIELDS};
}

export function validateRestoreSelection(input:{preview:RestorePreviewResult;current:ClockLogSnapshot[];selectedDocumentIds:string[];preRestoreBackupStatus:BackupStatus}) {
  if(input.preRestoreBackupStatus!=="succeeded")return {ok:false as const,code:"PRE_RESTORE_BACKUP_FAILED" as const};
  const stateHash=hash(input.current.map(log=>({id:log.id,data:comparable(log.data)})).sort((a,b)=>a.id.localeCompare(b.id)));
  if(stateHash!==input.preview.currentStateHash)return {ok:false as const,code:"RESTORE_PRECONDITION_FAILED" as const};
  const allowed=new Set(input.preview.candidates.filter(c=>c.eligibility!=="excluded"&&c.kind!=="duplicate_suspected").map(c=>c.documentId));
  if(!input.selectedDocumentIds.length||input.selectedDocumentIds.some(id=>!allowed.has(id)||id.includes("/")||id==="."||id===".."))return {ok:false as const,code:"RESTORE_PRECONDITION_FAILED" as const};
  return {ok:true as const,documentPaths:input.selectedDocumentIds.map(id=>`clockLogs/${id}`),payrollRecalculation:false};
}
