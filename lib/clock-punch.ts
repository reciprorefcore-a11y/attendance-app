export type ClockType = "clock_in" | "clock_out" | "break_start" | "break_end";

export type PunchErrorKind = "location" | "network" | "auth" | "permission" | "duplicate" | "state" | "unknown";

export class PunchError extends Error {
  readonly kind: PunchErrorKind;
  readonly retryable: boolean;

  constructor(
    kind: PunchErrorKind,
    message: string,
    retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PunchError";
    this.kind = kind;
    this.retryable = retryable;
  }
}

export const PUNCH_WINDOW_MS = 30_000;
export const FIRESTORE_TIMEOUT_MS = 15_000;
export const GPS_TIMEOUT_MS = 12_000;

export function getAllowedActions(last: ClockType | null): ClockType[] {
  if (last === null || last === "clock_out") return ["clock_in"];
  if (last === "clock_in" || last === "break_end") return ["break_start", "clock_out"];
  if (last === "break_start") return ["break_end"];
  return [];
}

export function createPunchId(employeeId: string, type: ClockType, nowMs: number): string {
  const safeEmployeeId = employeeId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safeEmployeeId}_${type}_${Math.floor(nowMs / PUNCH_WINDOW_MS)}`;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PunchError("network", message, true)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function firebaseCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) return "";
  return String((error as { code?: unknown }).code ?? "").replace(/^firestore\//, "");
}

export function toPunchError(error: unknown): PunchError {
  if (error instanceof PunchError) return error;
  const code = firebaseCode(error);
  if (["permission-denied"].includes(code)) {
    return new PunchError("permission", "権限エラーにより打刻を保存できません。管理者に連絡してください。", false, { cause: error });
  }
  if (["unauthenticated"].includes(code)) {
    return new PunchError("auth", "認証状態を確認できません。ページを再読み込みしてください。", true, { cause: error });
  }
  if (["unavailable", "deadline-exceeded", "aborted", "resource-exhausted", "internal", "unknown"].includes(code)) {
    return new PunchError("network", "通信が不安定で打刻を保存できませんでした。通信状態を確認して再試行してください。", true, { cause: error });
  }
  if (code === "failed-precondition") {
    return new PunchError("state", "直前の打刻状態が更新されています。状態を確認して再試行してください。", true, { cause: error });
  }
  return new PunchError("unknown", "打刻を保存できませんでした。再試行してください。", false, { cause: error });
}

export async function retryTransient<T>(operation: () => Promise<T>, retries = 1): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      const punchError = toPunchError(error);
      if (!punchError.retryable || attempt >= retries) throw punchError;
      attempt += 1;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

export type PositionResult = { latitude: number; longitude: number; accuracy: number };

export function getCurrentPosition(
  geolocation: Geolocation | undefined,
  timeoutMs = GPS_TIMEOUT_MS,
): Promise<PositionResult> {
  if (!geolocation) {
    return Promise.reject(new PunchError("location", "この端末では位置情報を取得できません。", false));
  }
  return new Promise((resolve, reject) => {
    geolocation.getCurrentPosition(
      ({ coords }) => resolve({ latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }),
      (error) => {
        if (error.code === 1) reject(new PunchError("permission", "位置情報の権限が拒否されています。端末の設定でこのサイトへの位置情報を許可してください。", false, { cause: error }));
        else if (error.code === 3) reject(new PunchError("location", "位置情報の取得がタイムアウトしました。屋外や窓際で再試行してください。", true, { cause: error }));
        else reject(new PunchError("location", "位置情報を取得できませんでした。GPSと通信状態を確認してください。", true, { cause: error }));
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 },
    );
  });
}

export function validateAccuracy(accuracy: number, radiusMeters: number): void {
  const allowedAccuracy = Math.max(100, radiusMeters);
  if (!Number.isFinite(accuracy) || accuracy > allowedAccuracy) {
    throw new PunchError("location", `位置情報の精度が不足しています（誤差 約${Math.round(accuracy)}m）。屋外や窓際で再試行してください。`, true);
  }
}

export function createSubmissionGuard() {
  let locked = false;
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    if (locked) throw new PunchError("duplicate", "打刻処理中です。完了までお待ちください。", false);
    locked = true;
    try { return await operation(); } finally { locked = false; }
  };
}
