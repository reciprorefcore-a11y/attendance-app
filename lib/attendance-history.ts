export type AttendanceHistoryRow = {
  id: string;
  logId: string;
  punchType: string;
  action: string;
  beforeTime: string | null;
  afterTime: string | null;
  performedBy: string;
  performedAt: string | null;
  reason: string;
};

const iso = (value: unknown) => {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return (value.toDate() as Date).toISOString();
  return typeof value === "string" ? value : null;
};

function legacyTime(value: Record<string, unknown> | null, type: string, logId: string) {
  if (!value) return null;
  if (type === "clock_in") return iso(value.clockIn);
  if (type === "clock_out") return iso(value.clockOut);
  const breaks = Array.isArray(value.breaks) ? value.breaks as Array<Record<string, unknown>> : [];
  const matched = breaks.find((item) => item.startLogId === logId || item.endLogId === logId);
  return type === "break_start" ? iso(matched?.start) : type === "break_end" ? iso(matched?.end) : null;
}

export function normalizeAttendanceHistory(logId: string, log: Record<string, unknown>, audits: Array<{ id: string; data: Record<string, unknown> }>): AttendanceHistoryRow[] {
  const rows: AttendanceHistoryRow[] = [];
  for (const audit of audits) {
    const targetIds = Array.isArray(audit.data.targetLogIds) ? audit.data.targetLogIds : [];
    const actions = Array.isArray(audit.data.actions) ? audit.data.actions as Array<Record<string, unknown>> : [];
    if (!targetIds.includes(logId) && !actions.some((item) => item.targetLogId === logId)) continue;
    const beforeList = Array.isArray(audit.data.before) ? audit.data.before as Array<Record<string, unknown>> : [];
    const afterList = Array.isArray(audit.data.after) ? audit.data.after as Array<Record<string, unknown>> : [];
    const legacyBefore = !Array.isArray(audit.data.before) && audit.data.before && typeof audit.data.before === "object" ? audit.data.before as Record<string, unknown> : null;
    const legacyAfter = !Array.isArray(audit.data.after) && audit.data.after && typeof audit.data.after === "object" ? audit.data.after as Record<string, unknown> : null;
    const before = beforeList.find((item) => item.id === logId);
    const after = afterList.find((item) => item.id === logId);
    const auditAction = actions.find((item) => item.targetLogId === logId);
    const punchType = String(before?.type ?? after?.type ?? auditAction?.type ?? log.type ?? "不明");
    rows.push({ id: `${audit.id}:${logId}`, logId, punchType, action: String(audit.data.action ?? (audit.data.deleteReason ? "attendance_deleted" : "attendance_corrected")), beforeTime: iso(before?.timestamp) ?? legacyTime(legacyBefore, punchType, logId), afterTime: iso(after?.timestamp) ?? legacyTime(legacyAfter, punchType, logId), performedBy: String(audit.data.performedByName ?? audit.data.performedBy ?? audit.data.correctedBy ?? "不明"), performedAt: iso(audit.data.performedAt ?? audit.data.correctedAt), reason: String(audit.data.deleteReason ?? audit.data.restoreReason ?? audit.data.correctionReason ?? "理由未記録") });
  }
  const legacyReason = log.correctionReason ?? log.editReason ?? log.manualEditReason ?? log.requestedCorrectionReason ?? log.creationReason ?? log.cancellationReason;
  if (rows.length === 0 && (legacyReason || log.isCorrected || log.isManualEdited || log.manuallyCreated || log.isCancelled)) rows.push({ id: `legacy-${logId}`, logId, punchType: String(log.type ?? "不明"), action: log.isCancelled ? "attendance_cancelled" : log.manuallyCreated ? "attendance_created" : "attendance_corrected", beforeTime: null, afterTime: iso(log.timestamp ?? log.createdAt), performedBy: String(log.correctedBy ?? log.manualEditedBy ?? log.cancelledBy ?? "不明"), performedAt: iso(log.correctedAt ?? log.manualEditedAt ?? log.cancelledAt), reason: String(legacyReason ?? "理由未記録") });
  return rows.sort((a, b) => String(b.performedAt ?? "").localeCompare(String(a.performedAt ?? "")));
}
