import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateLaborCostByStore,
  auditAttendance,
  buildAttendanceRows,
  calculateEstimatedLaborCost,
  calculateNightMinutes,
  diffMinutes,
  pairWorkSessions,
  type CalculationClockLog,
  type CalculationWage,
} from "../lib/attendance-calculation.ts";

const date = (value: string) => new Date(`${value}+09:00`);

function log(
  id: string,
  type: string,
  timestamp: string,
  options: Partial<CalculationClockLog> = {},
): CalculationClockLog {
  return {
    id,
    type,
    timestamp: date(timestamp),
    employeeId: "employee-1",
    employeeCode: "001",
    employeeName: "テスト",
    storeId: "store-a",
    storeName: "店舗A",
    ...options,
  };
}

const wage: CalculationWage = {
  hourlyWage: 1200,
  lateNightHourlyWage: 1500,
  dailyTransportation: 500,
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
};

test("seconds and milliseconds are truncated before calculating minutes", () => {
  for (const seconds of ["00", "18", "29", "30", "59"]) {
    assert.equal(
      diffMinutes(date("2026-07-24T22:00:00"), date(`2026-07-24T22:32:${seconds}`)),
      32,
    );
  }
  const [session] = pairWorkSessions([
    log("in", "clock_in", "2026-07-24T21:30:15"),
    log("out", "clock_out", "2026-07-24T22:32:59"),
  ]);
  assert.equal(session.workMinutes, 62);
  assert.equal(session.nightMinutes, 32);
});

test("night minutes cover all required cross-midnight boundaries", () => {
  const cases = [
    ["2026-07-24T22:00:00", "2026-07-25T05:00:00", 420, 420],
    ["2026-07-24T23:00:00", "2026-07-25T02:00:00", 180, 180],
    ["2026-07-24T01:00:00", "2026-07-24T05:00:00", 240, 240],
    ["2026-07-24T21:00:00", "2026-07-25T06:00:00", 540, 420],
  ] as const;
  for (const [start, end, work, night] of cases) {
    const [session] = pairWorkSessions([
      log(`in-${start}`, "clock_in", start),
      log(`out-${end}`, "clock_out", end),
    ]);
    assert.equal(session.workMinutes, work);
    assert.equal(session.nightMinutes, night);
  }
});

test("a cross-midnight session belongs to its clock-in date, including month end", () => {
  const rows = buildAttendanceRows([
    log("in", "clock_in", "2026-07-31T22:00:00"),
    log("out", "clock_out", "2026-08-01T02:00:00"),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date, "2026-07-31");
  assert.equal(rows[0].workMinutes, 240);
  assert.equal(rows[0].nightMinutes, 240);
});

test("a break in the night band reduces both work and night minutes", () => {
  const [session] = pairWorkSessions([
    log("in", "clock_in", "2026-07-24T22:00:00"),
    log("break-start", "break_start", "2026-07-25T01:00:00"),
    log("break-end", "break_end", "2026-07-25T01:30:00"),
    log("out", "clock_out", "2026-07-25T05:00:00"),
  ]);
  assert.equal(session.workMinutes, 390);
  assert.equal(session.nightMinutes, 390);
});

test("a break outside the night band only reduces work minutes", () => {
  const [session] = pairWorkSessions([
    log("in", "clock_in", "2026-07-24T21:00:00"),
    log("break-start", "break_start", "2026-07-24T21:30:00"),
    log("break-end", "break_end", "2026-07-24T21:45:00"),
    log("out", "clock_out", "2026-07-24T23:00:00"),
  ]);
  assert.equal(session.workMinutes, 105);
  assert.equal(session.nightMinutes, 60);
});

test("estimated labor cost uses normal wage, night wage, and daily transportation", () => {
  const result = calculateEstimatedLaborCost(
    { workMinutes: 120, nightMinutes: 60 },
    wage,
    true,
  );
  assert.equal(Math.round(result.amount), 3200);
  assert.equal(result.isWageMissing, false);
});

test("an applicable wageHistory takes priority over clock-log snapshots", () => {
  const rows = buildAttendanceRows(
    [
      log("in", "clock_in", "2026-07-24T21:00:00", {
        hourlyWageAtWork: 900,
        lateNightHourlyWageAtWork: 1000,
        dailyTransportationAtWork: 100,
      }),
      log("out", "clock_out", "2026-07-24T23:00:00"),
    ],
    { "employee-1": [wage] },
  );
  assert.equal(rows[0].wageAmount, 3200);
  assert.equal(rows[0].sessions[0].wageSource, "wage_history");
});

test("hourlyWageAtWork is used when wageHistory is empty", () => {
  const rows = buildAttendanceRows([
    log("in", "clock_in", "2026-07-24T21:00:00", {
      hourlyWageAtWork: "1200",
      dailyTransportationAtWork: "500",
    }),
    log("out", "clock_out", "2026-07-24T23:00:00"),
  ]);
  assert.equal(rows[0].wageAmount, 3200);
  assert.equal(rows[0].isWageMissing, false);
  assert.equal(rows[0].sessions[0].wageSource, "hourly_wage_at_work");
  assert.deepEqual(rows[0].sessions[0].wageDiagnostics, ["wage_history_empty"]);
});

test("hourlyWageSnapshot is used when wageHistory and at-work wage are absent", () => {
  const rows = buildAttendanceRows([
    log("in", "clock_in", "2026-07-24T09:00:00", {
      hourlyWageSnapshot: 1200,
    }),
    log("out", "clock_out", "2026-07-24T10:00:00"),
  ]);
  assert.equal(rows[0].wageAmount, 1200);
  assert.equal(rows[0].isWageMissing, false);
  assert.equal(rows[0].sessions[0].wageSource, "hourly_wage_snapshot");
});

test("a wageHistory fetch failure falls back to the clock-in snapshot", () => {
  const rows = buildAttendanceRows(
    [
      log("in", "clock_in", "2026-07-24T09:00:00", {
        hourlyWageAtWork: 1200,
      }),
      log("out", "clock_out", "2026-07-24T10:00:00", {
        hourlyWageAtWork: 9999,
      }),
    ],
    {},
    { "employee-1": "failed" },
  );
  assert.equal(rows[0].wageAmount, 1200);
  assert.equal(rows[0].isWageMissing, false);
  assert.equal(rows[0].sessions[0].wageSource, "hourly_wage_at_work");
  assert.deepEqual(rows[0].sessions[0].wageDiagnostics, [
    "wage_history_fetch_failed",
  ]);
});

test("other session logs are only used when the clock-in log has no snapshot", () => {
  const rows = buildAttendanceRows([
    log("in", "clock_in", "2026-07-24T09:00:00"),
    log("break", "break_start", "2026-07-24T09:15:00", {
      hourlyWageSnapshot: 1200,
    }),
    log("out", "clock_out", "2026-07-24T10:00:00", {
      hourlyWageAtWork: 9999,
    }),
  ]);
  assert.equal(rows[0].wageAmount, 1200);
  assert.equal(rows[0].sessions[0].wageSource, "hourly_wage_snapshot");
});

test("all missing wage sources are diagnosed as wage missing", () => {
  const rows = buildAttendanceRows([
    log("in", "clock_in", "2026-07-24T09:00:00"),
    log("out", "clock_out", "2026-07-24T10:00:00"),
  ]);
  assert.equal(rows[0].wageAmount, 0);
  assert.equal(rows[0].isWageMissing, true);
  assert.deepEqual(rows[0].sessions[0].wageDiagnostics, [
    "wage_history_empty",
    "clock_log_snapshot_missing",
    "wage_missing",
  ]);
});

test("daily transportation is added once for multiple sessions on the same day", () => {
  const rows = buildAttendanceRows([
    log("in-1", "clock_in", "2026-07-24T11:00:00", {
      hourlyWageAtWork: 1200,
      dailyTransportationAtWork: 500,
    }),
    log("out-1", "clock_out", "2026-07-24T15:00:00"),
    log("in-2", "clock_in", "2026-07-24T18:00:00", {
      hourlyWageAtWork: 1200,
      dailyTransportationAtWork: 500,
    }),
    log("out-2", "clock_out", "2026-07-24T22:00:00"),
  ]);
  assert.equal(rows[0].sessions.length, 2);
  assert.equal(rows[0].wageAmount, 10100);
});

test("labor cost is assigned to the clock-in store, not the employee home store", () => {
  const rows = buildAttendanceRows(
    [
      log("in", "clock_in", "2026-07-24T21:00:00", {
        storeId: "store-b",
        storeName: "店舗B",
      }),
      log("out", "clock_out", "2026-07-24T23:00:00", {
        storeId: "store-b",
        storeName: "店舗B",
      }),
    ],
    { "employee-1": [wage] },
  );
  const totals = aggregateLaborCostByStore(rows);
  assert.equal(totals.has("store-a"), false);
  assert.equal(totals.get("store-b")?.amount, 3200);
});

test("a missing wage is identified without stopping other store totals", () => {
  const rows = buildAttendanceRows(
    [
      log("a-in", "clock_in", "2026-07-24T21:00:00"),
      log("a-out", "clock_out", "2026-07-24T22:00:00"),
      log("b-in", "clock_in", "2026-07-24T21:00:00", {
        employeeId: "employee-2",
        employeeCode: "002",
        employeeName: "未設定者",
      }),
      log("b-out", "clock_out", "2026-07-24T22:00:00", {
        employeeId: "employee-2",
        employeeCode: "002",
        employeeName: "未設定者",
      }),
    ],
    { "employee-1": [wage] },
  );
  const totals = aggregateLaborCostByStore(rows);
  assert.equal(totals.get("store-a")?.amount, 1700);
  assert.deepEqual(totals.get("store-a")?.missingWageEmployeeKeys, ["employee-2"]);
});

test("malformed and incomplete punches do not stop valid sessions", () => {
  const sessions = pairWorkSessions([
    log("orphan-out", "clock_out", "2026-07-24T08:00:00"),
    log("valid-in", "clock_in", "2026-07-24T09:00:00"),
    log("valid-out", "clock_out", "2026-07-24T10:00:00"),
    log("incomplete-in", "clock_in", "2026-07-24T11:00:00"),
  ]);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].workMinutes, 60);
  assert.equal(sessions[1].clockOut, null);
});

test("night calculation also handles a session starting after midnight", () => {
  assert.equal(
    calculateNightMinutes(date("2026-07-24T01:00:00"), date("2026-07-24T05:00:00")),
    240,
  );
});

test("employee base wage is used as last resort when wageHistory and snapshots are absent", () => {
  const rows = buildAttendanceRows(
    [
      log("in", "clock_in", "2026-07-24T09:00:00"),
      log("out", "clock_out", "2026-07-24T10:00:00"),
    ],
    {},
    {},
    { "employee-1": 1200 },
  );
  assert.equal(rows[0].isWageMissing, false);
  assert.equal(rows[0].sessions[0].wageSource, "employee_base");
  assert.deepEqual(rows[0].sessions[0].wageDiagnostics, [
    "wage_history_empty",
    "clock_log_snapshot_missing",
  ]);
});

test("employee base wage fallback applies 1.25x night rate with no transportation", () => {
  // 21:00-23:00: workMinutes=120, nightMinutes=60
  // normal: 60/60 * 1200 = 1200, night: 60/60 * 1500 = 1500, transport: 0
  const rows = buildAttendanceRows(
    [
      log("in", "clock_in", "2026-07-24T21:00:00"),
      log("out", "clock_out", "2026-07-24T23:00:00"),
    ],
    {},
    {},
    { "employee-1": 1200 },
  );
  assert.equal(rows[0].wageAmount, 2700);
  assert.equal(rows[0].isWageMissing, false);
});

test("employee base wage is not used when wageHistory is applicable", () => {
  const rows = buildAttendanceRows(
    [
      log("in", "clock_in", "2026-07-24T09:00:00"),
      log("out", "clock_out", "2026-07-24T10:00:00"),
    ],
    { "employee-1": [wage] },
    {},
    { "employee-1": 800 },
  );
  assert.equal(rows[0].sessions[0].wageSource, "wage_history");
  assert.equal(rows[0].wageAmount, 1700);
});

test("employee base wage is not used when clock-log snapshot is present", () => {
  const rows = buildAttendanceRows(
    [
      log("in", "clock_in", "2026-07-24T09:00:00", { hourlyWageSnapshot: 1200 }),
      log("out", "clock_out", "2026-07-24T10:00:00"),
    ],
    {},
    {},
    { "employee-1": 800 },
  );
  assert.equal(rows[0].sessions[0].wageSource, "hourly_wage_snapshot");
  assert.equal(rows[0].wageAmount, 1200);
});

test("employee base wage fallback does not count transportation for same-day multiple sessions", () => {
  // transportation is 0 for employee_base, so two sessions share no transportation
  const rows = buildAttendanceRows(
    [
      log("in-1", "clock_in", "2026-07-24T09:00:00"),
      log("out-1", "clock_out", "2026-07-24T11:00:00"),
      log("in-2", "clock_in", "2026-07-24T13:00:00"),
      log("out-2", "clock_out", "2026-07-24T15:00:00"),
    ],
    {},
    {},
    { "employee-1": 1200 },
  );
  // 4 hours normal: 4 * 1200 = 4800, no night, no transportation
  assert.equal(rows[0].wageAmount, 4800);
  assert.equal(rows[0].isWageMissing, false);
});

test("4101 on 2026-08-13 keeps cross-store punches in their original sessions", () => {
  const logs = [
    log("pescara-in", "clock_in", "2026-08-13T17:57:13", {
      employeeId: "vwuoA0qj0Us1iFEmTO9r", employeeCode: "4101", employeeName: "溝上 太康",
      storeId: "3", workStoreName: "Pescara 綱島店",
    }),
    log("pescara-out", "clock_out", "2026-08-13T18:39:11", {
      employeeId: "vwuoA0qj0Us1iFEmTO9r", employeeCode: "4101", employeeName: "溝上 太康",
      storeId: "3", workStoreName: "Pescara 綱島店",
    }),
    log("graine-in", "clock_in", "2026-08-13T18:44:12", {
      employeeId: "vwuoA0qj0Us1iFEmTO9r", employeeCode: "4101", employeeName: "溝上 太康",
      storeId: "4", workStoreName: "Graine Marche 綱島店",
    }),
    log("next-day-pescara-out", "clock_out", "2026-08-14T23:04:06", {
      employeeId: "vwuoA0qj0Us1iFEmTO9r", employeeCode: "4101", employeeName: "溝上 太康",
      storeId: "3", workStoreName: "Pescara 綱島店",
    }),
  ];
  const rows = buildAttendanceRows(logs);
  const target = rows.find((row) => row.date === "2026-08-13");
  assert.ok(target);
  assert.equal(target.workMinutes, 42);
  assert.equal(target.nightMinutes, 0);
  assert.equal(target.breakMinutes, 0);
  assert.equal(target.clockIn.getHours(), 17);
  assert.equal(target.clockOut?.getHours(), 18);
  assert.equal(target.isMissingClockOut, true);
  assert.deepEqual(target.sessions.map((session) => [session.storeId, session.clockOut !== null]), [
    ["3", true],
    ["4", false],
  ]);
  const issues = auditAttendance(logs, rows);
  assert.ok(issues.some((issue) => issue.code === "missing_clock_out" && issue.date === "2026-08-13"));
  assert.ok(issues.some((issue) => issue.code === "orphan_clock_out" && issue.date === "2026-08-14"));
});

test("overlapping cross-store sessions use elapsed-time union instead of double counting", () => {
  const logs = [
    log("a-in", "clock_in", "2026-08-13T19:00:00", { storeId: "a", workStoreName: "店舗A" }),
    log("a-out", "clock_out", "2026-08-13T23:00:00", { storeId: "a", workStoreName: "店舗A" }),
    log("b-in", "clock_in", "2026-08-13T21:00:00", { storeId: "b", workStoreName: "店舗B" }),
    log("b-out", "clock_out", "2026-08-14T01:00:00", { storeId: "b", workStoreName: "店舗B" }),
  ];
  const [row] = buildAttendanceRows(logs);
  assert.equal(row.workMinutes, 360);
  assert.equal(row.nightMinutes, 180);
  assert.ok(row.diagnostics.some((diagnostic) => diagnostic.code === "overlapping_sessions"));
});
