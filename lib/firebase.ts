import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyCX145b-8MaT8qIIEWQODnVuBrP1Ur76pU",
  authDomain: "fublev-attendance.firebaseapp.com",
  projectId: "fublev-attendance",
  storageBucket: "fublev-attendance.firebasestorage.app",
  messagingSenderId: "723802054662",
  appId: "1:723802054662:web:000ad15a29503b5578e387",
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const storage = getStorage(app);
