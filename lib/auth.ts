"use client";

import { useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";

export type UserRole = "admin" | "manager" | "staff";

export type UserProfile = {
  uid: string;
  email: string | null;
  role: UserRole;
  storeId: string;
  name?: string;
};

type AuthProfileState = {
  user: User | null;
  profile: UserProfile | null;
  isLoading: boolean;
  error: string;
};

function isUserRole(value: unknown): value is UserRole {
  return value === "admin" || value === "manager" || value === "staff";
}

export function useAuthProfile(): AuthProfileState {
  const [state, setState] = useState<AuthProfileState>({
    user: null,
    profile: null,
    isLoading: true,
    error: "",
  });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      if (!nextUser) {
        setState({ user: null, profile: null, isLoading: false, error: "" });
        return;
      }

      try {
        const userSnap = await getDoc(doc(db, "users", nextUser.uid));
        const data = userSnap.data();
        const role = data?.role;
        const storeId = typeof data?.storeId === "string" ? data.storeId : "";

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
            name: typeof data?.name === "string" ? data.name : undefined,
          },
          isLoading: false,
          error: "",
        });
      } catch (error) {
        console.error("user profile fetch failed", error);
        setState({
          user: nextUser,
          profile: null,
          isLoading: false,
          error: "ユーザー権限の取得に失敗しました。",
        });
      }
    });

    return unsubscribe;
  }, []);

  return state;
}
