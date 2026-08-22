import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, serverTimestamp, setDoc, writeBatch } from "firebase/firestore";

let environment;

before(async () => {
  environment = await initializeTestEnvironment({
    projectId: "attendance-rules-test",
    firestore: {
      rules: await readFile(new URL("../firestore.rules", import.meta.url), "utf8"),
    },
  });

  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "users", "admin-user"), {
      role: "admin",
    });
    await setDoc(doc(context.firestore(), "users", "staff-user"), {
      role: "staff",
    });
    await setDoc(doc(context.firestore(), "users", "manager-user"), { role: "manager", storeId: "store-a" });
    await setDoc(
      doc(
        context.firestore(),
        "employees",
        "employee-1",
        "wageHistory",
        "wage-1",
      ),
      {
        hourlyWage: 1200,
        lateNightHourlyWage: 1500,
        dailyTransportation: 500,
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      },
    );
    await setDoc(
      doc(
        context.firestore(),
        "employees",
        "staff-user",
        "wageHistory",
        "wage-1",
      ),
      { hourlyWage: 1100 },
    );
  });
});

after(async () => {
  await environment?.cleanup();
});

const wageRef = (firestore, wageId = "wage-1") =>
  doc(firestore, "employees", "employee-1", "wageHistory", wageId);

test("unauthenticated users cannot read wageHistory", async () => {
  const firestore = environment.unauthenticatedContext().firestore();
  await assertFails(getDoc(wageRef(firestore)));
});

test("staff users cannot read their own or another employee's wageHistory", async () => {
  const firestore = environment
    .authenticatedContext("staff-user")
    .firestore();
  await assertFails(getDoc(wageRef(firestore)));
  await assertFails(
    getDoc(
      doc(
        firestore,
        "employees",
        "staff-user",
        "wageHistory",
        "wage-1",
      ),
    ),
  );
});

test("admin users can read wageHistory", async () => {
  const firestore = environment
    .authenticatedContext("admin-user")
    .firestore();
  const snapshot = await assertSucceeds(getDoc(wageRef(firestore)));
  assert.equal(snapshot.data()?.hourlyWage, 1200);
});

test("admin users can write wageHistory", async () => {
  const firestore = environment
    .authenticatedContext("admin-user")
    .firestore();
  await assertSucceeds(
    setDoc(wageRef(firestore, "wage-admin"), {
      hourlyWage: 1300,
      lateNightHourlyWage: 1600,
      dailyTransportation: 500,
      effectiveFrom: "2026-07-01",
      effectiveTo: null,
    }),
  );
});

test("staff users cannot write wageHistory", async () => {
  const firestore = environment
    .authenticatedContext("staff-user")
    .firestore();
  await assertFails(
    setDoc(wageRef(firestore, "wage-staff"), {
      hourlyWage: 9999,
    }),
  );
});

test("clock page can read clock logs even while signed in", async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "clockLogs", "punch-1"), {
      employeeId: "employee-1",
      storeId: "store-a",
      type: "clock_in",
    });
  });
  const firestore = environment.authenticatedContext("staff-user").firestore();
  await assertSucceeds(getDoc(doc(firestore, "clockLogs", "punch-1")));
});

test("clock state accepts valid atomic state and rejects malformed state", async () => {
  const firestore = environment.unauthenticatedContext().firestore();
  await assertSucceeds(setDoc(doc(firestore, "clockStates", "employee-1"), {
    employeeId: "employee-1",
    lastType: "clock_in",
    lastLogId: "employee-1_clock_in_1",
    storeId: "store-a",
    updatedAt: serverTimestamp(),
  }));
  await assertFails(setDoc(doc(firestore, "clockStates", "employee-2"), {
    employeeId: "different-employee",
    lastType: "invalid",
    lastLogId: "bad",
    storeId: "store-a",
    updatedAt: serverTimestamp(),
  }));
});

test("admin can atomically correct a punch and create its audit history", async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "clockLogs", "correct-target"), {
      employeeId: "employee-1", storeId: "store-a", type: "clock_in", timestamp: new Date(),
    });
  });
  const firestore = environment.authenticatedContext("admin-user").firestore();
  const batch = writeBatch(firestore);
  batch.update(doc(firestore, "clockLogs", "correct-target"), {
    isCorrected: true,
    correctedAt: serverTimestamp(),
    correctedBy: "admin-user",
    correctionReason: "テスト修正",
  });
  batch.set(doc(firestore, "auditLogs", "audit-correction"), {
    targetLogIds: ["correct-target"],
    before: { timestamp: "before" },
    after: { timestamp: "after" },
    correctedAt: serverTimestamp(),
    correctedBy: "admin-user",
    correctionReason: "テスト修正",
    actions: [{ targetLogId: "correct-target", action: "update" }],
  });
  await assertSucceeds(batch.commit());
});

test("payroll snapshots are admin-only", async () => {
  const adminDb = environment.authenticatedContext("admin-user").firestore();
  const managerDb = environment.authenticatedContext("manager-user").firestore();
  const staffDb = environment.authenticatedContext("staff-user").firestore();
  await assertSucceeds(setDoc(doc(adminDb, "payrollRuns", "run-1"), { targetMonth: "2026-07", status: "draft" }));
  await assertSucceeds(setDoc(doc(adminDb, "payrollRuns", "run-1", "employees", "employee-1"), { netPay: 100000 }));
  await assertSucceeds(setDoc(doc(adminDb, "payrollRuns", "run-1", "auditLogs", "audit-1"), { action: "cancel_confirmation" }));
  await assertFails(getDoc(doc(managerDb, "payrollRuns", "run-1")));
  await assertFails(getDoc(doc(staffDb, "payrollRuns", "run-1", "employees", "employee-1")));
  await assertFails(getDoc(doc(managerDb, "payrollRuns", "run-1", "auditLogs", "audit-1")));
  await assertFails(setDoc(doc(managerDb, "payrollRuns", "run-2"), { status: "draft" }));
  await assertSucceeds(setDoc(doc(adminDb, "payrollSettings", "employee-1"), { healthInsurance: 10000 }));
  await assertFails(getDoc(doc(managerDb, "payrollSettings", "employee-1")));
  await assertFails(setDoc(doc(staffDb, "payrollSettings", "employee-1"), { healthInsurance: 0 }));
});
