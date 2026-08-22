/**
 * Lightweight Firestore REST API client + Firebase Auth token verification.
 * Replaces firebase-admin SDK so no FIREBASE_SERVICE_ACCOUNT_JSON is needed.
 * Uses NEXT_PUBLIC_FIREBASE_API_KEY and NEXT_PUBLIC_FIREBASE_PROJECT_ID.
 */

const PROJ = () => process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "";
const APIKEY = () => process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "";
const FSBASE = () =>
  `https://firestore.googleapis.com/v1/projects/${PROJ()}/databases/(default)/documents`;

// ─── Firestore field type conversion ─────────────────────────────────────────

type FsField = Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromField(v: unknown): any {
  if (!v || typeof v !== "object") return null;
  const f = v as FsField;
  if ("stringValue" in f) return f.stringValue;
  if ("integerValue" in f) return Number(f.integerValue);
  if ("doubleValue" in f) return Number(f.doubleValue);
  if ("booleanValue" in f) return f.booleanValue;
  if ("nullValue" in f) return null;
  if ("timestampValue" in f) return new Date(f.timestampValue as string);
  if ("arrayValue" in f) {
    const a = f.arrayValue as { values?: unknown[] };
    return (a.values ?? []).map(fromField);
  }
  if ("mapValue" in f) {
    const m = f.mapValue as { fields?: FsField };
    return fromFields(m.fields ?? {});
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromFields(fields: FsField): Record<string, any> {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, fromField(v)]));
}

function toField(v: unknown): unknown {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "string") return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === "number")
    return Number.isInteger(v) && Math.abs(v) < 2 ** 53
      ? { integerValue: String(v) }
      : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toField) } };
  if (typeof v === "object") return { mapValue: { fields: toFields(v as Record<string, unknown>) } };
  return { nullValue: null };
}

function toFields(data: Record<string, unknown>): FsField {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, toField(v)]));
}

function genId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 20 }, () => chars[Math.floor(Math.random() * 62)]).join("");
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

async function fsRequest(
  token: string,
  url: string,
  method = "GET",
  body?: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) {
    // runQuery は失敗時に配列 [{ error: {...} }] を返すため、両方の形を見る。
    let detail = "";
    try {
      const parsed: unknown = JSON.parse(text);
      const err = (Array.isArray(parsed) ? (parsed[0] as { error?: { message?: string } } | undefined)?.error : (parsed as { error?: { message?: string } })?.error);
      detail = err?.message ?? "";
    } catch { /* non-JSON */ }
    throw new Error(`Firestore HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return JSON.parse(text);
}

// ─── Snapshots ────────────────────────────────────────────────────────────────

export class RestDocSnapshot {
  readonly id: string;
  readonly exists: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _data: Record<string, any>;

  constructor(raw: Record<string, unknown>, id: string) {
    this.id = id;
    this.exists = !!raw.name;
    this._data = fromFields((raw.fields ?? {}) as FsField);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data(): Record<string, any> { return this._data; }
}

export class RestQuerySnapshot {
  constructor(readonly docs: RestDocSnapshot[]) {}
  get empty() { return this.docs.length === 0; }
}

// ─── DocRef ───────────────────────────────────────────────────────────────────

export class RestDocRef {
  readonly id: string;
  readonly _docPath: string;

  constructor(private _token: string, colPath: string, id?: string) {
    this.id = id ?? genId();
    this._docPath = `${colPath}/${this.id}`;
  }

  collection(name: string): RestCollectionRef {
    return new RestCollectionRef(this._token, `${this._docPath}/${name}`);
  }

  async get(): Promise<RestDocSnapshot> {
    try {
      const raw = await fsRequest(this._token, `${FSBASE()}/${this._docPath}`) as Record<string, unknown>;
      return new RestDocSnapshot(raw, this.id);
    } catch (e) {
      if (e instanceof Error && (e.message.includes("NOT_FOUND") || e.message.includes("404"))) {
        return new RestDocSnapshot({}, this.id);
      }
      throw e;
    }
  }

  _setWrite(data: object) {
    const d = data as Record<string, unknown>;
    return { update: { name: `${FSBASE()}/${this._docPath}`, fields: toFields(d) } };
  }

  _updateWrite(data: object) {
    const d = data as Record<string, unknown>;
    return {
      update: { name: `${FSBASE()}/${this._docPath}`, fields: toFields(d) },
      updateMask: { fieldPaths: Object.keys(d) },
    };
  }
}

// ─── CollectionRef ────────────────────────────────────────────────────────────

type WhereFilter = { field: string; op: string; value: unknown };

const OP_MAP: Record<string, string> = {
  "==": "EQUAL", "!=": "NOT_EQUAL",
  "<": "LESS_THAN", "<=": "LESS_THAN_OR_EQUAL",
  ">": "GREATER_THAN", ">=": "GREATER_THAN_OR_EQUAL",
};

export class RestCollectionRef {
  constructor(
    private _token: string,
    readonly _colPath: string,
    private _filters: WhereFilter[] = [],
    private _limitVal?: number,
  ) {}

  doc(id?: string): RestDocRef {
    return new RestDocRef(this._token, this._colPath, id);
  }

  where(field: string, op: string, value: unknown): RestCollectionRef {
    return new RestCollectionRef(this._token, this._colPath, [...this._filters, { field, op, value }], this._limitVal);
  }

  limit(n: number): RestCollectionRef {
    return new RestCollectionRef(this._token, this._colPath, [...this._filters], n);
  }

  async get(): Promise<RestQuerySnapshot> {
    if (this._filters.length === 0 && !this._limitVal) {
      // Simple list — GET endpoint
      const url = `${FSBASE()}/${this._colPath}?pageSize=5000`;
      const raw = await fsRequest(this._token, url).catch((e: Error) => { throw new Error(`${e.message} [list ${this._colPath}]`); }) as Record<string, unknown>;
      const documents = (raw.documents as unknown[] | undefined) ?? [];
      const docs = documents.map((d) => {
        const doc = d as Record<string, unknown>;
        const name = doc.name as string;
        return new RestDocSnapshot(doc, name.split("/").pop()!);
      });
      return new RestQuerySnapshot(docs);
    }

    // Structured query — runQuery endpoint
    const colId = this._colPath.split("/").pop()!;
    const parentPath = this._colPath.split("/").slice(0, -1).join("/");
    const parentUrl = parentPath ? `${FSBASE()}/${parentPath}` : FSBASE();

    const makeFilter = (f: WhereFilter) => ({
      fieldFilter: {
        field: { fieldPath: f.field },
        op: OP_MAP[f.op] ?? "EQUAL",
        value: toField(f.value),
      },
    });

    const whereClause =
      this._filters.length === 1
        ? makeFilter(this._filters[0])
        : { compositeFilter: { op: "AND", filters: this._filters.map(makeFilter) } };

    const query: Record<string, unknown> = {
      structuredQuery: {
        from: [{ collectionId: colId }],
        ...(this._filters.length > 0 ? { where: whereClause } : {}),
        ...(this._limitVal != null ? { limit: this._limitVal } : {}),
      },
    };

    const raw = await fsRequest(this._token, `${parentUrl}:runQuery`, "POST", query).catch((e: Error) => { throw new Error(`${e.message} [query ${this._colPath}]`); }) as unknown[];
    const docs = raw
      .filter((r) => (r as Record<string, unknown>).document)
      .map((r) => {
        const doc = ((r as Record<string, unknown>).document) as Record<string, unknown>;
        const name = doc.name as string;
        return new RestDocSnapshot(doc, name.split("/").pop()!);
      });
    return new RestQuerySnapshot(docs);
  }
}

// ─── Batch ────────────────────────────────────────────────────────────────────

export class RestBatch {
  private _writes: unknown[] = [];
  constructor(private _token: string) {}

  set(ref: RestDocRef, data: object): void {
    this._writes.push(ref._setWrite(data));
  }

  update(ref: RestDocRef, data: object): void {
    this._writes.push(ref._updateWrite(data));
  }

  async commit(): Promise<void> {
    if (this._writes.length === 0) return;
    await fsRequest(this._token, `${FSBASE()}:batchWrite`, "POST", { writes: this._writes }).catch((e: Error) => { throw new Error(`${e.message} [batchWrite ${this._writes.length}件]`); });
  }
}

// ─── Transaction ─────────────────────────────────────────────────────────────

export class RestTransaction {
  _writes: unknown[] = [];
  constructor(private _token: string) {}

  get(ref: RestDocRef): Promise<RestDocSnapshot>;
  get(col: RestCollectionRef): Promise<RestQuerySnapshot>;
  async get(refOrCol: RestDocRef | RestCollectionRef): Promise<RestDocSnapshot | RestQuerySnapshot> {
    return refOrCol.get() as Promise<RestDocSnapshot | RestQuerySnapshot>;
  }

  set(ref: RestDocRef, data: object): void {
    this._writes.push(ref._setWrite(data));
  }

  update(ref: RestDocRef, data: object): void {
    this._writes.push(ref._updateWrite(data));
  }
}

// ─── Main Firestore client ────────────────────────────────────────────────────

export class FirestoreRest {
  constructor(private _token: string) {}

  collection(name: string): RestCollectionRef {
    return new RestCollectionRef(this._token, name);
  }

  batch(): RestBatch {
    return new RestBatch(this._token);
  }

  async runTransaction<T>(fn: (transaction: RestTransaction) => Promise<T>): Promise<T> {
    const tx = new RestTransaction(this._token);
    const result = await fn(tx);
    if (tx._writes.length > 0) {
      await fsRequest(this._token, `${FSBASE()}:batchWrite`, "POST", { writes: tx._writes });
    }
    return result;
  }
}

// ─── Token verification + admin role check ────────────────────────────────────

export async function verifyAdminToken(
  authorization: string | null,
): Promise<{ uid: string; db: FirestoreRest } | null> {
  const apiKey = APIKEY();
  const projectId = PROJ();

  if (!apiKey || !projectId) {
    console.error("[payroll-auth] NEXT_PUBLIC_FIREBASE_API_KEY or NEXT_PUBLIC_FIREBASE_PROJECT_ID not set");
    return null;
  }
  if (!authorization?.startsWith("Bearer ")) {
    console.error("[payroll-auth] Missing or malformed Authorization header");
    return null;
  }
  const token = authorization.slice(7);

  // Step 1: verify ID token via Firebase Auth REST API
  let uid: string;
  try {
    const lookupRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken: token }) },
    );
    const lookupData = await lookupRes.json() as Record<string, unknown>;
    if (!lookupRes.ok) {
      const errMsg = (lookupData.error as Record<string, unknown> | undefined)?.message ?? lookupRes.status;
      console.error("[payroll-auth] Token verification failed:", errMsg);
      return null;
    }
    const users = lookupData.users as Array<{ localId: string }> | undefined;
    uid = users?.[0]?.localId ?? "";
    if (!uid) { console.error("[payroll-auth] Token lookup returned no user"); return null; }
  } catch (e) {
    console.error("[payroll-auth] Token lookup error:", e instanceof Error ? e.message : "unknown");
    return null;
  }

  // Step 2: confirm role === "admin" in Firestore users/{uid}
  // Uses the user's own token so Firestore rules apply — consistent with useAuthProfile
  try {
    const docRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const docData = await docRes.json() as Record<string, unknown>;
    if (!docRes.ok) {
      console.error("[payroll-auth] users/{uid} read failed — status:", docRes.status, "uid:", uid);
      return null;
    }
    const fields = docData.fields as FsField | undefined;
    const role = (fields?.role as { stringValue?: string } | undefined)?.stringValue;
    if (role !== "admin") {
      console.error("[payroll-auth] Access denied — uid:", uid, "role:", role ?? "(field missing)");
      return null;
    }
  } catch (e) {
    console.error("[payroll-auth] Role check error:", e instanceof Error ? e.message : "unknown");
    return null;
  }

  return { uid, db: new FirestoreRest(token) };
}
