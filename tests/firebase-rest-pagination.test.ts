import assert from "node:assert/strict";
import test from "node:test";
import { collectFirestorePages } from "../lib/firestore-pagination.ts";
import { buildAttendanceRows, type CalculationClockLog } from "../lib/attendance-calculation.ts";

test("unfiltered Firestore REST reads every page instead of losing later clock-outs", async () => {
  const requested: string[] = [];
  const documents = await collectFirestorePages(async (pageToken) => {
    requested.push(pageToken);
    if (!pageToken) {
      return {
        items: [{ id: "in", type: "clock_in" }],
        nextPageToken: "page 2/token",
      };
    }
    assert.equal(pageToken, "page 2/token");
    return { items: [{ id: "out", type: "clock_out" }] };
  });
  assert.deepEqual(documents.map((item) => item.id), ["in", "out"]);
  assert.deepEqual(requested, ["", "page 2/token"]);
});

test("19 clock-ins on the first REST page pair with their clock-outs on the next page", async () => {
  const employeeCodes = ["1065", "4101", "4120", "7014", "7016", "4114", "4103", "7014b", "4101b", "4103b", "4112", "4120b", "4120c", "4086", "4120d", "8160", "4114b", "8160b", "7014c"];
  const dates = employeeCodes.map((_, index) => new Date(Date.UTC(2026, 7, 2 + index, 6, 0)));
  const makeLog = (index: number, type: string, timestamp: Date): CalculationClockLog => ({
    id: `${type}-${index}`,
    employeeId: `employee-${index}`,
    employeeCode: employeeCodes[index],
    employeeName: `従業員${index}`,
    storeId: index === 0 ? "1" : "3",
    workStoreName: index === 0 ? "灯武蔵小杉店" : "テスト店舗",
    type,
    timestamp,
  });
  const logs = await collectFirestorePages(async (pageToken) => {
    if (!pageToken) {
      return {
        items: dates.map((timestamp, index) => makeLog(index, "clock_in", timestamp)),
        nextPageToken: "clock-outs",
      };
    }
    return { items: dates.map((timestamp, index) => makeLog(index, "clock_out", new Date(timestamp.getTime() + 4 * 60 * 60 * 1000))) };
  });
  const rows = buildAttendanceRows(logs);
  assert.equal(rows.length, 19);
  assert.equal(rows.filter((row) => row.isMissingClockOut).length, 0);
  assert.ok(rows.every((row) => row.workMinutes === 240));
  const inoue = rows.find((row) => row.employeeCode === "1065");
  assert.equal(inoue?.storeName, "灯武蔵小杉店");
  assert.equal(inoue?.diagnostics.length, 0);
});
