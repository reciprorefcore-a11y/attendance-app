import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateLaborCostByStore,
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
