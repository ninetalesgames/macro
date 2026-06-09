import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDtQYXhOW188SNsouu5sjQZMys49C0LdiE",
  authDomain: "macro-9ff77.firebaseapp.com",
  projectId: "macro-9ff77",
  storageBucket: "macro-9ff77.firebasestorage.app",
  messagingSenderId: "931759050243",
  appId: "1:931759050243:web:db0d6c5f1cbee7a99f0836",
  measurementId: "G-98R16NKDGN",
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
