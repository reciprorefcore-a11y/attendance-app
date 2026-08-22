import assert from "node:assert/strict";
import test from "node:test";
import { isPayrollPreviewReadOnly, payrollPreviewHealth } from "../lib/payroll-preview.ts";

test("read-only is enabled only for Preview with the explicit flag", () => {
  const before = { env: process.env.VERCEL_ENV, flag: process.env.PAYROLL_PREVIEW_READ_ONLY };
  process.env.VERCEL_ENV = "preview";
  process.env.PAYROLL_PREVIEW_READ_ONLY = "true";
  assert.equal(isPayrollPreviewReadOnly(), true);
  process.env.VERCEL_ENV = "production";
  assert.equal(isPayrollPreviewReadOnly(), false);
  process.env.VERCEL_ENV = before.env;
  process.env.PAYROLL_PREVIEW_READ_ONLY = before.flag;
});

test("health exposes validation booleans without credential fields", () => {
  const before = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({ project_id: "fublev-attendance", private_key: "secret" });
  const health = payrollPreviewHealth();
  assert.equal(health.serviceAccountJsonValid, true);
  assert.equal(health.serviceAccountProjectMatches, true);
  assert.equal(JSON.stringify(health).includes("secret"), false);
  assert.equal("project_id" in health, false);
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = before;
});
