import XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) throw new Error("usage: node scripts/generate-tax-table-2026.mjs source.xls");
const workbook = XLSX.readFile(source);
const rows = XLSX.utils.sheet_to_json(workbook.Sheets["月額表"], { header: 1, raw: true })
  .filter((row) => typeof row[1] === "number" && typeof row[2] === "number" && row.slice(3, 12).every((value) => typeof value === "number"))
  .map((row) => ({ min: row[1], max: row[2], kou: row.slice(3, 11), otsu: row[11] }));
const directory = path.dirname(fileURLToPath(import.meta.url));
const output = path.join(directory, "..", "lib", "tax-tables", "2026.ts");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `// 国税庁公式Excelから scripts/generate-tax-table-2026.mjs で生成\nexport default ${JSON.stringify({ year: 2026, source: "国税庁 令和8年分 給与所得の源泉徴収税額表（月額表）", rows }, null, 2)} as const;\n`);
console.log(`generated ${rows.length} rows: ${output}`);
