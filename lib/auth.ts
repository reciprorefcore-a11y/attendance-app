"use client";

import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

export type UserRole = "admin" | "fc_manager" | "area_manager" | "manager" | "staff";

export type UserProfile = {
  uid: string;
  email: string | null;
  role: UserRole;
  storeId: string;       // manager 用
  storeIds?: string[];   // area_manager / fc_manager 用（複数店舗）
  name?: string;
};

type AuthProfileState = {
  user: User | null;
  profile: UserProfile | null;
  isLoading: boolean;
  error: string;
};

function isUserRole(value: unknown): value is UserRole {
  return (
    value === "admin" ||
    value === "fc_manager" ||
    value === "area_manager" ||
    value === "manager" ||
    value === "staff"
  );
}

export function useAuthProfile(): AuthProfileState {
  const [state, setState] = useState<AuthProfileState>({
    user: null,
    profile: null,
    isLoading: true,
    error: "",
  });

  useEffect(() => {
    let cancelled = false;

    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      if (!nextUser) {
        if (!cancelled) {
          setState({ user: null, profile: null, isLoading: false, error: "" });
        }
        return;
      }

      try {
        const userSnap = await getDoc(doc(db, "users", nextUser.uid));
        if (cancelled) return;

        const data = userSnap.data();
        const role = data?.role;
        const storeId = typeof data?.storeId === "string" ? data.storeId : "";
        const storeIds = Array.isArray(data?.storeIds) ? (data.storeIds as string[]) : undefined;

        if (!userSnap.exists() || !isUserRole(role)) {
          setState({
            user: nextUser,
            profile: null,
            isLoading: false,
            error: "このアカウントに権限が設定されていません。",
          });
          return;
        }

        setState({
          user: nextUser,
          profile: {
            uid: nextUser.uid,
            email: nextUser.email,
            role,
            storeId,
            storeIds,
            name: typeof data?.name === "string" ? data.name : undefined,
          },
          isLoading: false,
          error: "",
        });
      } catch (error) {
        console.error("user profile fetch failed", error);
        if (!cancelled) {
          setState({
            user: nextUser,
            profile: null,
            isLoading: false,
            error: "ユーザー権限の取得に失敗しました。",
          });
        }
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return state;
}
