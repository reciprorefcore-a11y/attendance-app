import * as fs from "fs";
import * as path from "path";

const PROJECT_ID = "fublev-attendance";
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Firebase CLI の公式 OAuth 認証情報
const CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

function getRefreshToken(): string {
  const configPath = path.join(
    process.env.HOME ?? "",
    ".config/configstore/firebase-tools.json",
  );
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const token = config?.tokens?.refresh_token;
  if (!token) throw new Error("refresh_token not found");
  return token;
}

async function refreshAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}

type FirestoreDoc = {
  name: string;
  fields?: Record<string, Record<string, unknown>>;
};

async function fetchAll(token: string, collection: string): Promise<FirestoreDoc[]> {
  const results: FirestoreDoc[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${BASE}/${collection}`);
    url.searchParams.set("pageSize", "300");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`GET ${collection} failed: ${res.status} ${await res.text()}`);

    const json = (await res.json()) as { documents?: FirestoreDoc[]; nextPageToken?: string };
    results.push(...(json.documents ?? []));
    pageToken = json.nextPageToken;
  } while (pageToken);

  return results;
}

function getNum(doc: FirestoreDoc, field: string): number | null {
  const f = doc.fields?.[field];
  if (!f) return null;
  if ("integerValue" in f) return Number(f.integerValue);
  if ("doubleValue" in f) return Number(f.doubleValue);
  return null;
}

function getStr(doc: FirestoreDoc, field: string): string | null {
  const f = doc.fields?.[field];
  if (!f) return null;
  if ("stringValue" in f) return f.stringValue as string;
  return null;
}

async function patchField(token: string, docName: string, field: string, value: number): Promise<void> {
  const url = `https://firestore.googleapis.com/v1/${docName}?updateMask.fieldPaths=${field}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: { [field]: { integerValue: String(value) } } }),
  });
  if (!res.ok) throw new Error(`PATCH failed for ${docName}: ${res.status} ${await res.text()}`);
}

async function main() {
  const refreshToken = getRefreshToken();
  console.log("アクセストークンを取得中...");
  const token = await refreshAccessToken(refreshToken);

  console.log("clockLogs を取得中...");
  const clockLogs = await fetchAll(token, "clockLogs");
  console.log(`clockLogs: ${clockLogs.length} 件`);

  const targets = clockLogs.filter((doc) => {
    const wage = getNum(doc, "hourlyWageAtWork");
    return wage === null || wage === 0;
  });
  console.log(`hourlyWageAtWork が 0 または未設定: ${targets.length} 件`);

  if (targets.length === 0) {
    console.log("更新対象なし。終了します。");
    return;
  }

  console.log("employees を取得中...");
  const employees = await fetchAll(token, "employees");

  // employeeId → hourlyWage のマップ（hourlyWage > 0 の従業員のみ）
  const wageMap = new Map<string, number>();
  for (const emp of employees) {
    const empId = emp.name.split("/").pop()!;
    const wage = getNum(emp, "hourlyWage") ?? getNum(emp, "baseHourlyWage") ?? getNum(emp, "baseWage");
    if (wage !== null && wage > 0) {
      wageMap.set(empId, wage);
    }
  }
  console.log(`時給 > 0 の従業員: ${wageMap.size} 名`);

  let updatedCount = 0;
  let skippedNoId = 0;
  let skippedNoWage = 0;

  for (const log of targets) {
    const employeeId = getStr(log, "employeeId");
    if (!employeeId) { skippedNoId++; continue; }

    const wage = wageMap.get(employeeId);
    // hourlyWage > 0 の従業員のみ更新（0 または未設定は月給制としてスキップ）
    if (!wage) { skippedNoWage++; continue; }

    await patchField(token, log.name, "hourlyWageAtWork", wage);
    updatedCount++;
  }

  console.log(`\n完了:`);
  console.log(`  更新: ${updatedCount} 件`);
  console.log(`  スキップ（employeeId なし）: ${skippedNoId} 件`);
  console.log(`  スキップ（時給未設定または月給制）: ${skippedNoWage} 件`);
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
