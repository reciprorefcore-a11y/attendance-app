import assert from "node:assert/strict";
import test from "node:test";
import { Timestamp } from "firebase/firestore";
import { buildAttendanceRows, type CalculationClockLog } from "../lib/attendance-calculation.ts";
import { buildDailyAttendance, type Timecard } from "../lib/attendance.ts";

type Punch = {
  id: string;
  type: string;
  at: string;
  storeId?: string;
  storeName?: string;
};

function compare(punches: Punch[]) {
  const calculationLogs: CalculationClockLog[] = punches.map((punch) => ({
    id: punch.id,
    employeeId: "employee-1065",
    employeeCode: "1065",
    employeeName: "井上 美咲",
    storeId: punch.storeId ?? "1",
    workStoreName: punch.storeName ?? "灯武蔵小杉店",
    type: punch.type,
    timestamp: new Date(`${punch.at}+09:00`),
  }));
  const timecards = punches.map((punch) => ({
    id: punch.id,
    employeeId: "employee-1065",
    employeeCode: "1065",
    employeeName: "井上 美咲",
    storeId: punch.storeId ?? "1",
    storeName: punch.storeName ?? "灯武蔵小杉店",
    type: punch.type as Timecard["type"],
    createdAt: Timestamp.fromDate(new Date(`${punch.at}+09:00`)),
  } as Timecard & { id: string }));
  return {
    payroll: buildAttendanceRows(calculationLogs)[0],
    excel: buildDailyAttendance(timecards)[0],
  };
}

test("payroll validation and attendance Excel agree for Inoue on 2026-08-22", () => {
  const { payroll, excel } = compare([
    { id: "in", type: "clock_in", at: "2026-08-22T15:36:00" },
    { id: "out", type: "clock_out", at: "2026-08-22T20:00:00" },
  ]);
  assert.equal(payroll.workMinutes, 264);
  assert.equal(excel.workMinutes, 264);
  assert.equal(payroll.clockOut?.getTime(), excel.clockOut?.getTime());
  assert.equal(payroll.isMissingClockOut, false);
});

test("payroll validation and attendance Excel agree when support-shift stores differ", () => {
  const { payroll, excel } = compare([
    { id: "in", type: "clock_in", at: "2026-08-22T15:00:00", storeId: "support", storeName: "応援先" },
    { id: "out", type: "clock_out", at: "2026-08-22T20:00:00", storeId: "home", storeName: "所属店" },
  ]);
  assert.equal(payroll.workMinutes, excel.workMinutes);
  assert.equal(payroll.clockOut?.getTime(), excel.clockOut?.getTime());
  assert.equal(payroll.isMissingClockOut, false);
});

test("break punches do not become work boundaries in either path", () => {
  const { payroll, excel } = compare([
    { id: "in", type: "clock_in", at: "2026-08-22T15:00:00" },
    { id: "break-in", type: "break_start", at: "2026-08-22T17:00:00" },
    { id: "break-out", type: "break_end", at: "2026-08-22T17:30:00" },
    { id: "out", type: "clock_out", at: "2026-08-22T20:00:00" },
  ]);
  assert.equal(payroll.workMinutes, 270);
  assert.equal(excel.workMinutes, 270);
  assert.equal(payroll.isMissingClockOut, false);
});
