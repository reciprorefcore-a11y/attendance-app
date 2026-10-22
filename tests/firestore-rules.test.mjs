import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, serverTimestamp, setDoc, updateDoc, writeBatch } from "firebase/firestore";

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
    await setDoc(doc(context.firestore(), "employees", "history-admin"), { name: "fixture-admin", storeId: "store-b", employeeType: "partTime", status: "active" });
    await setDoc(doc(context.firestore(), "employees", "history-manager"), { name: "fixture-manager", storeId: "store-a", employeeType: "partTime", status: "active" });
    await setDoc(doc(context.firestore(), "employees", "history-other-store"), { name: "fixture-other", storeId: "store-b", employeeType: "partTime", status: "active" });
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

const historyData=(employeeId,storeId)=>({employeeId,storeId,action:"論理削除",effectiveFrom:"2026-08-31",reason:"その他：fixture",performedBy:"fixture-user",performedAt:serverTimestamp()});

test("admin can atomically logically delete an employee and create changeHistory",async()=>{
  const firestore=environment.authenticatedContext("admin-user").firestore(),batch=writeBatch(firestore);
  batch.update(doc(firestore,"employees","history-admin"),{isDeleted:true,status:"deleted",isActive:false});
  batch.set(doc(firestore,"employees","history-admin","changeHistory","history-1"),historyData("history-admin","store-b"));
  await assertSucceeds(batch.commit());
});

test("manager can create deletion history only for an employee in own store",async()=>{
  const firestore=environment.authenticatedContext("manager-user").firestore(),own=writeBatch(firestore);
  own.update(doc(firestore,"employees","history-manager"),{isDeleted:true,status:"deleted",isActive:false});
  own.set(doc(firestore,"employees","history-manager","changeHistory","history-1"),historyData("history-manager","store-a"));
  await assertSucceeds(own.commit());
  const other=writeBatch(firestore);
  other.update(doc(firestore,"employees","history-other-store"),{isDeleted:true,status:"deleted",isActive:false});
  other.set(doc(firestore,"employees","history-other-store","changeHistory","history-1"),historyData("history-other-store","store-b"));
  await assertFails(other.commit());
});

test("employee changeHistory cannot be updated or physically deleted",async()=>{
  const firestore=environment.authenticatedContext("admin-user").firestore(),ref=doc(firestore,"employees","history-admin","changeHistory","history-1");
  await assertFails(updateDoc(ref,{reason:"改ざん"}));
  await assertFails(deleteDoc(ref));
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

test("clockLogs physical delete is denied for staff, manager, and admin", async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "clockLogs", "delete-target"), {
      employeeId: "employee-1", storeId: "store-a", type: "clock_in", isCancelled: true,
    });
  });
  for (const uid of ["staff-user", "manager-user", "admin-user"]) {
    const firestore = environment.authenticatedContext(uid).firestore();
    await assertFails(deleteDoc(doc(firestore, "clockLogs", "delete-target")));
  }
  await environment.withSecurityRulesDisabled(async (context) => {
    assert.equal((await getDoc(doc(context.firestore(), "clockLogs", "delete-target"))).exists(), true);
  });
});

test("normal clock punch create remains allowed", async () => {
  const firestore = environment.unauthenticatedContext().firestore();
  await assertSucceeds(setDoc(doc(firestore, "clockLogs", "normal-punch"), {
    employeeId: "employee-1", storeId: "store-a", type: "clock_in", timestamp: serverTimestamp(),
  }));
});

test("manager can logically cancel own-store clockLogs", async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "clockLogs", "cancel-target"), {
      employeeId: "employee-1", storeId: "store-a", type: "clock_out", isCancelled: false,
    });
  });
  const firestore = environment.authenticatedContext("manager-user").firestore();
  await assertSucceeds(updateDoc(doc(firestore, "clockLogs", "cancel-target"), {
    isCancelled: true, cancellationReason: "fixture取消", cancelledBy: "manager-user", cancelledAt: serverTimestamp(),
  }));
});

test("clockLogsの論理削除フィールドはmanagerを拒否しadminだけ変更できる", async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "clockLogs", "logical-delete-target"), { employeeId: "employee-1", storeId: "store-a", type: "clock_in", isDeleted: false });
  });
  const managerDb = environment.authenticatedContext("manager-user").firestore();
  await assertFails(updateDoc(doc(managerDb, "clockLogs", "logical-delete-target"), { isDeleted: true, deletedAt: serverTimestamp(), deletedBy: "manager-user", deleteReason: "fixture" }));
  const adminDb = environment.authenticatedContext("admin-user").firestore();
  await assertSucceeds(updateDoc(doc(adminDb, "clockLogs", "logical-delete-target"), { isDeleted: true, deletedAt: serverTimestamp(), deletedBy: "admin-user", deleteReason: "fixture" }));
});

test("clockLogsの削除取消メタデータもmanagerは変更できない", async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "clockLogs", "restore-target"), {
      employeeId: "employee-1", storeId: "store-a", type: "clock_in", isDeleted: true,
      deletionBatchId: "batch-1",
    });
  });
  const managerDb = environment.authenticatedContext("manager-user").firestore();
  await assertFails(updateDoc(doc(managerDb, "clockLogs", "restore-target"), {
    isDeleted: false, restoredAt: serverTimestamp(), restoredBy: "manager-user", restoreReason: "fixture",
  }));
});

test("manager cannot update another store clockLogs", async () => {
  await environment.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), "clockLogs", "other-store-target"), {
      employeeId: "employee-2", storeId: "store-b", type: "clock_in",
    });
  });
  const firestore = environment.authenticatedContext("manager-user").firestore();
  await assertFails(updateDoc(doc(firestore, "clockLogs", "other-store-target"), { isCancelled: true }));
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
