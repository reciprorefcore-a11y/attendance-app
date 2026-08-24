import test from "node:test";
import assert from "node:assert/strict";
import { calculateAutomaticStatutoryDeductions } from "../lib/payroll-statutory.ts";
test("加入状態・標準報酬未設定なら社会保険を推測しない",()=>{ const result=calculateAutomaticStatutoryDeductions({taxableEarnings:304000}); assert.equal(result.socialInsuranceTotal,null); });
test("明示された標準報酬から社会保険・2026年度雇用保険を自動計算",()=>{ const result=calculateAutomaticStatutoryDeductions({taxableEarnings:304000,socialInsuranceEnrolled:true,standardMonthlyRemuneration:320000,careInsuranceApplicable:true,employmentInsuranceEnrolled:true}); assert.deepEqual([result.healthInsurance,result.childSupportContribution,result.careInsurance,result.employeePension,result.employmentInsurance],[15872,368,2592,29280,1520]); });
