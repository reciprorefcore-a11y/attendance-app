import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cert, initializeApp } from "firebase-admin/app";
import { Timestamp, getFirestore } from "firebase-admin/firestore";

const serviceAccountPath = process.argv[2];
const adminUid = process.argv[3];
if (!serviceAccountPath || !adminUid) throw new Error("service account path and admin uid are required");
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf8"));
if (serviceAccount.project_id !== "fublev-attendance") throw new Error("unexpected Firebase project");
const app = initializeApp({ credential: cert(serviceAccount) }, `resident-tax-${Date.now()}`);
const db = getFirestore(app);
const ref = db.collection("payrollSettings").doc("hvjU14BKDB0pCdDrUZF1");
const admin = await db.collection("users").doc(adminUid).get();
if (!admin.exists || admin.data()?.role !== "admin") throw new Error("updatedBy is not an active admin profile");

function normalize(value: unknown): unknown {
  if (value instanceof Timestamp) return { __timestamp: value.toDate().toISOString() };
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
  return value;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(normalize(value)) ?? "__undefined").digest("hex");
const withoutHistory = (data: Record<string, unknown>) => Object.fromEntries(Object.entries(data).filter(([key]) => key !== "residentTaxHistory"));

const before = await ref.get();
if (!before.exists) throw new Error("Nakamura payrollSettings does not exist");
const beforeData = before.data() ?? {};
const accessToken = await app.options.credential!.getAccessToken();
const response = await fetch(`https://firestore.googleapis.com/v1/projects/${serviceAccount.project_id}/databases/(default)/documents/payrollSettings/hvjU14BKDB0pCdDrUZF1`, { headers: { Authorization: `Bearer ${accessToken.access_token}` } });
if (!response.ok || !response.headers.get("date")) throw new Error("could not obtain Firestore server time");
const serverTimestamp = Timestamp.fromDate(new Date(response.headers.get("date")!));
const previousHistory = Array.isArray(beforeData.residentTaxHistory) ? beforeData.residentTaxHistory as Array<Record<string, unknown>> : [];
let matched = false;
const history = previousHistory.map((entry) => {
  if (entry.effectiveMonth !== "2026-08") return entry;
  matched = true;
  return { ...entry, effectiveMonth: "2026-08", amount: 14100, updatedAt: serverTimestamp, updatedBy: adminUid };
});
if (!matched) history.push({ effectiveMonth: "2026-08", amount: 14100, updatedAt: serverTimestamp, updatedBy: adminUid });

const outputDir = `/private/tmp/attendance-app-nakamura-resident-tax-${new Date().toISOString().replace(/[:.]/g, "-")}`;
mkdirSync(outputDir, { recursive: true });
writeFileSync(`${outputDir}/before.json`, JSON.stringify({ path: ref.path, data: normalize(beforeData), hash: hash(beforeData), nonHistoryHash: hash(withoutHistory(beforeData)) }, null, 2));
await db.runTransaction(async (transaction) => {
  const latest = await transaction.get(ref);
  if (!latest.exists || hash(latest.data()) !== hash(beforeData)) throw new Error("payrollSettings changed after backup; aborted");
  transaction.update(ref, { residentTaxHistory: history });
});
const after = await ref.get();
const afterData = after.data() ?? {};
const entries = (Array.isArray(afterData.residentTaxHistory) ? afterData.residentTaxHistory : []).filter((entry: Record<string, unknown>) => entry.effectiveMonth === "2026-08");
const report = {
  path: ref.path, adminUid, before: normalize(beforeData), after: normalize(afterData),
  beforeHash: hash(beforeData), afterHash: hash(afterData),
  beforeNonHistoryHash: hash(withoutHistory(beforeData)), afterNonHistoryHash: hash(withoutHistory(afterData)),
  nonHistoryFieldsUnchanged: hash(withoutHistory(beforeData)) === hash(withoutHistory(afterData)),
  effectiveMonthEntryCount: entries.length,
  effectiveMonthEntry: normalize(entries[0]),
};
writeFileSync(`${outputDir}/after.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outputDir, path: ref.path, adminUid, nonHistoryFieldsUnchanged: report.nonHistoryFieldsUnchanged, effectiveMonthEntryCount: entries.length, effectiveMonthEntry: report.effectiveMonthEntry }, null, 2));
