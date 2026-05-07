import * as fs from "fs";
import * as path from "path";

const PROJECT_ID = "fublev-attendance";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function getAccessToken(): string {
  const configPath = path.join(
    process.env.HOME ?? "",
    ".config/configstore/firebase-tools.json",
  );
  const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  const token = config?.tokens?.access_token;
  if (!token) throw new Error("access_token not found in firebase-tools config");
  return token;
}

async function listAllStores(token: string): Promise<{ name: string; gpsRadiusMeters?: number }[]> {
  const results: { name: string; gpsRadiusMeters?: number }[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${BASE_URL}/stores`);
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`List stores failed: ${res.status} ${text}`);
    }

    const json = (await res.json()) as {
      documents?: { name: string; fields?: Record<string, unknown> }[];
      nextPageToken?: string;
    };

    for (const doc of json.documents ?? []) {
      const fields = doc.fields as Record<string, { integerValue?: string; doubleValue?: string }> | undefined;
      const radiusField = fields?.gpsRadiusMeters;
      const radius = radiusField
        ? Number(radiusField.integerValue ?? radiusField.doubleValue ?? NaN)
        : undefined;
      results.push({ name: doc.name, gpsRadiusMeters: radius });
    }

    pageToken = json.nextPageToken;
  } while (pageToken);

  return results;
}

async function patchGpsRadius(token: string, docName: string): Promise<void> {
  const url = `https://firestore.googleapis.com/v1/${docName}?updateMask.fieldPaths=gpsRadiusMeters`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        gpsRadiusMeters: { integerValue: "50" },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Patch failed for ${docName}: ${res.status} ${text}`);
  }
}

async function main() {
  const token = getAccessToken();
  const stores = await listAllStores(token);
  const targets = stores.filter((s) => s.gpsRadiusMeters === 100);

  console.log(`全店舗数: ${stores.length} 件 / 更新対象 (gpsRadiusMeters=100): ${targets.length} 件`);

  await Promise.all(targets.map((s) => patchGpsRadius(token, s.name)));

  console.log(`更新完了: ${targets.length} 件の店舗の gpsRadiusMeters を 100 → 50 に更新しました。`);
}

main().catch((err) => {
  console.error("エラー:", err);
  process.exit(1);
});
