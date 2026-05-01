"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import { useAuthProfile } from "@/lib/auth";
import { db } from "@/lib/firebase";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  where,
} from "firebase/firestore";

// ─── 型定義 ───────────────────────────────────────────────────────────────

type ClockType = "clock_in" | "clock_out" | "break_start" | "break_end";

type StoreDoc = {
  name?: string;
  logoUrl?: string;
  latitude?: number;
  longitude?: number;
  gpsRadiusMeters?: number;
  helpWage?: number;
  active?: boolean;
};

type EmployeeDoc = {
  id: string;
  name: string;
  nameKana?: string;
  employeeCode: string;
  storeId: string;
  baseWage?: number;
  baseHourlyWage?: number;
  status: "active" | "inactive" | "pending" | "rejected";
  pin?: string; // 4桁PIN（Firestoreの employees ドキュメントに追加が必要）
};

type GpsState = {
  latitude: number | null;
  longitude: number | null;
  distanceMeters: number | null;
  isOutsideGps: boolean;
  message: string;
};

// ─── 打刻許可ロジック ───────────────────────────────────────────────────────
// 直前の打刻タイプに応じて、次に押せるボタンを決定する

function getAllowedActions(last: ClockType | null): ClockType[] {
  if (last === null || last === "clock_out") return ["clock_in"];
  if (last === "clock_in" || last === "break_end") return ["break_start", "clock_out"];
  if (last === "break_start") return ["break_end"];
  return [];
}

// ─── ボタン定義 ─────────────────────────────────────────────────────────────

const clockButtons: { type: ClockType; label: string; tone: "primary" | "dark" | "light" }[] = [
  { type: "clock_in", label: "出勤", tone: "primary" },
  { type: "clock_out", label: "退勤", tone: "dark" },
  { type: "break_start", label: "休憩開始", tone: "light" },
  { type: "break_end", label: "休憩終了", tone: "light" },
];

// ─── ユーティリティ関数 ──────────────────────────────────────────────────────

function calcDistance(lat1: number, lng1: number, lat2: number, lng2: number) {
  const radius = 6371000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function storeName(store: StoreDoc | null) { return store?.name ?? ""; }
function storeLatitude(store: StoreDoc | null) { return store?.latitude ?? null; }
function storeLongitude(store: StoreDoc | null) { return store?.longitude ?? null; }
function storeRadius(store: StoreDoc | null) { return store?.gpsRadiusMeters ?? 0; }
function storeHelpWage(store: StoreDoc | null) { return store?.helpWage ?? null; }
function storeLogo(store: StoreDoc | null) { return store?.logoUrl || "/assets/logo-placeholder.png"; }

// ─── メインコンポーネント ────────────────────────────────────────────────────

function ClockPageContent() {
  const searchParams = useSearchParams();
  const storeId = searchParams.get("storeId") ?? "";
  const { user, profile, isLoading: isAuthLoading } = useAuthProfile();
  const effectiveStoreId = storeId || profile?.storeId || "";

  const [store, setStore] = useState<StoreDoc | null>(null);
  const [employees, setEmployees] = useState<EmployeeDoc[]>([]);
  const [employeeId, setEmployeeId] = useState("");

  // PIN 認証
  const [pinInput, setPinInput] = useState("");
  const [pinVerified, setPinVerified] = useState(false);
  const [pinError, setPinError] = useState("");

  // 直前の打刻タイプ（二重打刻防止）
  const [lastPunchType, setLastPunchType] = useState<ClockType | null>(null);
  const [isLastPunchLoading, setIsLastPunchLoading] = useState(false);

  // GPS
  const [gps, setGps] = useState<GpsState>({
    latitude: null,
    longitude: null,
    distanceMeters: null,
    isOutsideGps: false,
    message: "位置情報は未取得です",
  });

  // UI 状態
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [successMessage, setSuccessMessage] = useState("");

  // ─── 店舗・従業員データ取得 ──────────────────────────────────────────────

  useEffect(() => {
    if (isAuthLoading) return;
    if (!effectiveStoreId) return;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setErrorMessage("");
    setSuccessMessage("");
    setStore(null);
    setEmployees([]);
    setEmployeeId("");
    setPinInput("");
    setPinVerified(false);
    setPinError("");
    setLastPunchType(null);

    const unsubscribe = onSnapshot(
      doc(db, "stores", effectiveStoreId),
      async (storeSnap) => {
        if (!storeSnap.exists()) {
          setErrorMessage("店舗情報が見つかりません");
          setStore(null);
          setEmployees([]);
          setEmployeeId("");
          setIsLoading(false);
          return;
        }

        const nextStore = storeSnap.data() as StoreDoc;
        if (nextStore.active === false) {
          setErrorMessage("この店舗は無効です");
          setStore(null);
          setEmployees([]);
          setEmployeeId("");
          setIsLoading(false);
          return;
        }

        setStore(nextStore);
        setErrorMessage("");

        try {
          // Firestore クエリで絞り込み済みのため、クライアント側の .filter() は不要
          const employeeSnapshot = await getDocs(
            query(
              collection(db, "employees"),
              where("status", "==", "active"),
              where("storeId", "==", effectiveStoreId),
            ),
          );
          const rows = employeeSnapshot.docs.map((employeeDoc) => ({
            id: employeeDoc.id,
            ...(employeeDoc.data() as Omit<EmployeeDoc, "id">),
          }));

          const signedInEmployee =
            rows.find((e) => e.id === user?.uid) ??
            rows.find((e) => profile?.name && e.name === profile.name) ??
            null;

          setEmployees(rows);
          setEmployeeId((current) =>
            rows.some((e) => e.id === current)
              ? current
              : signedInEmployee?.id ?? rows[0]?.id ?? "",
          );
        } catch (error) {
          console.error("clock employees fetch failed", error);
          setErrorMessage("従業員データの取得に失敗しました。");
        } finally {
          setIsLoading(false);
        }
      },
      (error) => {
        console.error("clock store subscription failed", error);
        setErrorMessage("データ取得に失敗しました。通信状態またはFirebase設定を確認してください。");
        setStore(null);
        setEmployees([]);
        setEmployeeId("");
        setIsLoading(false);
      },
    );

    return unsubscribe;
  }, [effectiveStoreId, isAuthLoading, profile?.name, user?.uid]);

  // ─── 従業員が変わったら PIN をリセット ──────────────────────────────────

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPinInput("");
    setPinVerified(false);
    setPinError("");
    setLastPunchType(null);
    setSuccessMessage("");
  }, [employeeId]);

  // ─── PIN 認証後に直前の打刻タイプを取得 ──────────────────────────────────

  useEffect(() => {
    if (!pinVerified || !employeeId) return;

    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLastPunchLoading(true);

    const fetchLastPunch = async () => {
      try {
        const snap = await getDocs(
          query(
            collection(db, "clockLogs"),
            where("employeeId", "==", employeeId),
            orderBy("timestamp", "desc"),
            limit(1),
          ),
        );
        if (cancelled) return;
        if (snap.empty) {
          setLastPunchType(null);
        } else {
          const data = snap.docs[0].data();
          setLastPunchType((data.type as ClockType) ?? null);
        }
      } catch (error) {
        console.error("last punch fetch failed", error);
      } finally {
        if (!cancelled) setIsLastPunchLoading(false);
      }
    };

    fetchLastPunch();
    return () => { cancelled = true; };
  }, [pinVerified, employeeId]);

  // ─── GPS 取得 ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!store) return;
    const lat = storeLatitude(store);
    const lng = storeLongitude(store);
    const radius = storeRadius(store);

    if (lat === null || lng === null || !radius || !navigator.geolocation) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGps((current) => ({
        ...current,
        distanceMeters: null,
        isOutsideGps: false,
        message: "GPS取得不可のため位置未確認で打刻できます",
      }));
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const distance = calcDistance(
          position.coords.latitude,
          position.coords.longitude,
          lat,
          lng,
        );
        const isOutsideGps = distance > radius;
        setGps({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          distanceMeters: distance,
          isOutsideGps,
          message: isOutsideGps ? "GPS許可範囲外です。打刻は可能です。" : "GPS確認OK",
        });
      },
      () => {
        setGps({
          latitude: null,
          longitude: null,
          distanceMeters: null,
          isOutsideGps: false,
          message: "GPS取得不可のため位置未確認で打刻できます",
        });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
    );
  }, [store]);

  // ─── 派生値 ──────────────────────────────────────────────────────────────

  const currentStore = effectiveStoreId ? store : null;

  const selectedEmployee = useMemo(
    () => employees.find((e) => e.id === employeeId) ?? null,
    [employeeId, employees],
  );

  const allowedActions = useMemo(
    () => (pinVerified ? getAllowedActions(lastPunchType) : []),
    [pinVerified, lastPunchType],
  );

  // ─── PIN 確認 ─────────────────────────────────────────────────────────────

  const verifyPin = () => {
    if (!selectedEmployee) return;
    const storedPin = selectedEmployee.pin ?? "";
    if (!storedPin) {
      // PIN未設定の従業員は打刻不可
      setPinError("PINが設定されていません。管理者に連絡してください。");
      return;
    }
    if (pinInput === storedPin) {
      setPinVerified(true);
      setPinError("");
    } else {
      setPinError("PINが正しくありません");
      setPinInput("");
    }
  };

  // ─── 打刻送信 ────────────────────────────────────────────────────────────

  const punch = async (type: ClockType) => {
    if (!effectiveStoreId || !currentStore) {
      setErrorMessage("店舗情報が見つかりません");
      return;
    }
    if (!selectedEmployee) {
      setErrorMessage("有効な従業員がいません");
      return;
    }
    if (!pinVerified) {
      setErrorMessage("PIN認証が完了していません");
      return;
    }
    if (!allowedActions.includes(type)) {
      setErrorMessage("この操作は現在実行できません");
      return;
    }

    const helpWage = storeHelpWage(currentStore);
    const baseWage = selectedEmployee.baseWage ?? selectedEmployee.baseHourlyWage ?? 0;
    const hourlyWageSnapshot =
      typeof helpWage === "number" && helpWage > 0 ? helpWage : baseWage;
    const wageSource =
      typeof helpWage === "number" && helpWage > 0 ? "store_help" : "employee_base";

    setIsSubmitting(true);
    setSuccessMessage("");
    setErrorMessage("");

    try {
      await addDoc(collection(db, "clockLogs"), {
        employeeId: selectedEmployee.id,
        employeeName: selectedEmployee.name,
        employeeCode: selectedEmployee.employeeCode,
        storeId: effectiveStoreId,
        storeName: storeName(currentStore),
        type,
        timestamp: serverTimestamp(), // createdAt は削除（重複のため）
        hourlyWageSnapshot,
        wageSource,
        latitude: gps.latitude,
        longitude: gps.longitude,
        isOutsideGps: gps.isOutsideGps,
      });

      setLastPunchType(type); // 直前の打刻を即時更新（再取得なしで UI を反映）
      setSuccessMessage("打刻しました");

      // 成功メッセージを 3 秒後に自動クリア
      setTimeout(() => setSuccessMessage(""), 3000);

      // 打刻後は PIN をリセットし、次の従業員の操作に備える
      setPinVerified(false);
      setPinInput("");
    } catch (error) {
      console.error("clock save failed", error);
      setErrorMessage("打刻の保存に失敗しました。通信状態またはFirebase設定を確認してください。");
    } finally {
      setIsSubmitting(false);
    }
  };

  // ─── レンダリング ─────────────────────────────────────────────────────────

  const logoSrc = storeLogo(currentStore);

  return (
    <main style={styles.page}>
      <div style={styles.logoHero}>
        {logoSrc.startsWith("/") ? (
          <Image
            src={logoSrc}
            alt="店舗ロゴ"
            width={180}
            height={180}
            priority
            style={styles.heroLogo}
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoSrc} alt="店舗ロゴ" style={styles.heroLogo} />
        )}
      </div>
      <div style={styles.heroStoreName}>{storeName(currentStore)}</div>

      <section style={styles.card}>
        {!effectiveStoreId && !isAuthLoading && (
          <p style={styles.error}>店舗情報が見つかりません</p>
        )}
        {effectiveStoreId && isLoading && <p style={styles.info}>読み込み中</p>}
        {isAuthLoading && <p style={styles.info}>ログイン確認中</p>}
        {errorMessage && <p style={styles.error}>{errorMessage}</p>}
        {currentStore && employees.length === 0 && !isLoading && !errorMessage && (
          <p style={styles.error}>有効な従業員がいません</p>
        )}
        {successMessage && <p style={styles.success}>{successMessage}</p>}

        {currentStore && (
          <>
            {/* 従業員選択 */}
            <label style={styles.label}>
              従業員
              <select
                value={employeeId}
                onChange={(event) => {
                  setEmployeeId(event.target.value);
                  setSuccessMessage("");
                  setErrorMessage("");
                }}
                style={styles.select}
              >
                {employees.map((employee) => (
                  <option key={employee.id} value={employee.id}>
                    {employee.employeeCode} {employee.name}
                  </option>
                ))}
              </select>
            </label>

            {/* PIN 入力（未認証時のみ表示） */}
            {!pinVerified && (
              <div style={styles.pinBox}>
                <label style={styles.label}>
                  PIN（4桁）
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={4}
                    value={pinInput}
                    onChange={(event) => {
                      setPinInput(event.target.value.replace(/\D/g, "").slice(0, 4));
                      setPinError("");
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && pinInput.length === 4) verifyPin();
                    }}
                    style={styles.pinInput}
                    placeholder="••••"
                  />
                </label>
                {pinError && <p style={styles.error}>{pinError}</p>}
                <button
                  type="button"
                  onClick={verifyPin}
                  disabled={pinInput.length !== 4}
                  style={styles.pinButton}
                >
                  確認
                </button>
              </div>
            )}

            {/* 打刻ボタン（PIN 認証済みかつ直前打刻取得完了後） */}
            {pinVerified && (
              <>
                {isLastPunchLoading ? (
                  <p style={styles.info}>打刻状態を確認中...</p>
                ) : (
                  <div style={styles.actions}>
                    {clockButtons.map((button) => {
                      const allowed = allowedActions.includes(button.type);
                      return (
                        <button
                          key={button.type}
                          type="button"
                          onClick={() => punch(button.type)}
                          disabled={isSubmitting || !selectedEmployee || !allowed}
                          style={{
                            ...(button.tone === "primary"
                              ? styles.primaryButton
                              : button.tone === "dark"
                                ? styles.darkButton
                                : styles.lightButton),
                            ...(!allowed ? styles.disabledButton : {}),
                          }}
                        >
                          {button.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {/* GPS 表示 */}
            <div style={gps.isOutsideGps ? styles.gpsWarning : styles.gpsBox}>
              <p style={styles.gpsMain}>{gps.message}</p>
              {gps.distanceMeters !== null && (
                <p style={styles.gpsSub}>
                  距離 {Math.round(gps.distanceMeters)}m / 許可範囲 {storeRadius(currentStore)}m
                </p>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

export default function ClockPage() {
  return (
    <Suspense fallback={<main style={styles.page}>読み込み中</main>}>
      <ClockPageContent />
    </Suspense>
  );
}

// ─── スタイル ─────────────────────────────────────────────────────────────────

const styles = {
  page: {
    minHeight: "100svh",
    background: "#F6F8FB",
    padding: "40px 16px 24px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    color: "#363A3D",
  },
  logoHero: {
    marginBottom: 18,
    width: 196,
    height: 196,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  heroLogo: {
    width: 180,
    height: 180,
    objectFit: "contain",
  },
  heroStoreName: {
    color: "#363A3D",
    fontSize: 18,
    fontWeight: 800,
    marginBottom: 24,
    textAlign: "center",
  },
  card: {
    width: "100%",
    maxWidth: 430,
    background: "#ffffff",
    borderRadius: 20,
    padding: 22,
    display: "flex",
    flexDirection: "column",
    gap: 16,
    boxShadow: "0 18px 45px rgba(15, 23, 42, 0.10)",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    fontSize: 14,
    fontWeight: 800,
  },
  select: {
    minHeight: 56,
    borderRadius: 14,
    border: "1px solid #CBD5E1",
    padding: "0 14px",
    fontSize: 18,
    background: "#ffffff",
  },
  pinBox: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  pinInput: {
    minHeight: 56,
    borderRadius: 14,
    border: "1px solid #CBD5E1",
    padding: "0 14px",
    fontSize: 28,
    letterSpacing: 8,
    textAlign: "center",
    background: "#ffffff",
  },
  pinButton: {
    minHeight: 52,
    border: 0,
    borderRadius: 14,
    background: "#53C1ED",
    color: "#ffffff",
    fontSize: 18,
    fontWeight: 900,
  },
  gpsBox: {
    borderRadius: 14,
    background: "#F8FAFC",
    border: "1px solid #E2E8F0",
    padding: 14,
  },
  gpsWarning: {
    borderRadius: 14,
    background: "#FFFBEB",
    border: "1px solid #F59E0B",
    padding: 14,
  },
  gpsMain: {
    margin: 0,
    fontWeight: 800,
  },
  gpsSub: {
    margin: "6px 0 0",
    color: "#64748B",
    fontSize: 13,
  },
  actions: {
    display: "grid",
    gap: 12,
  },
  primaryButton: {
    minHeight: 72,
    border: 0,
    borderRadius: 16,
    background: "#53C1ED",
    color: "#ffffff",
    fontSize: 24,
    fontWeight: 900,
    cursor: "pointer",
  },
  darkButton: {
    minHeight: 72,
    border: 0,
    borderRadius: 16,
    background: "#3BAED6",
    color: "#ffffff",
    fontSize: 24,
    fontWeight: 900,
    cursor: "pointer",
  },
  lightButton: {
    minHeight: 58,
    border: "1px solid #CBD5E1",
    borderRadius: 16,
    background: "#ffffff",
    color: "#363A3D",
    fontSize: 18,
    fontWeight: 800,
    cursor: "pointer",
  },
  disabledButton: {
    opacity: 0.35,
    cursor: "not-allowed",
  },
  error: {
    margin: 0,
    borderRadius: 14,
    background: "#FEF2F2",
    color: "#991B1B",
    border: "1px solid #FCA5A5",
    padding: 12,
    fontWeight: 700,
  },
  success: {
    margin: 0,
    borderRadius: 16,
    background: "#ECFDF5",
    color: "#047857",
    border: "1px solid #10B981",
    padding: 16,
    textAlign: "center",
    fontSize: 24,
    fontWeight: 900,
  },
  info: {
    margin: 0,
    borderRadius: 14,
    background: "#F0FBFE",
    color: "#3BAED6",
    border: "1px solid #BDEBFA",
    padding: 12,
    fontWeight: 700,
  },
} satisfies Record<string, React.CSSProperties>;
