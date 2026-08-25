import * as adminSdk from "firebase-admin";

let initialized = false;
let initializationErrorCode: "ADMIN_CREDENTIAL_MISSING" | "ADMIN_CREDENTIAL_INVALID" | null = null;

export function getAdminAuth(): adminSdk.auth.Auth | null {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) { initializationErrorCode="ADMIN_CREDENTIAL_MISSING"; return null; }

  if (!initialized) {
    try {
      const serviceAccount = JSON.parse(serviceAccountJson) as adminSdk.ServiceAccount;
      if (!adminSdk.apps.length) {
        adminSdk.initializeApp({ credential: adminSdk.credential.cert(serviceAccount) });
      }
      initialized = true;
      initializationErrorCode=null;
    } catch {
      initializationErrorCode="ADMIN_CREDENTIAL_INVALID";
      console.error(JSON.stringify({event:"firebase_admin_init_failed",errorCode:initializationErrorCode}));
      return null;
    }
  }

  return adminSdk.auth();
}

export function getAdminInitializationErrorCode(){return initializationErrorCode;}

export function getAdminDb(): adminSdk.firestore.Firestore | null {
  if (!getAdminAuth()) return null;
  return adminSdk.firestore();
}

export { verifyAdminToken } from "@/lib/firebase-rest";
