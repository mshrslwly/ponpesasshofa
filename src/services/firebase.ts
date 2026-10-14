import { initializeApp, getApps, getApp, FirebaseApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';
import { getFirestore, Firestore } from 'firebase/firestore';

// Safely read optional firebase-applet-config.json if it exists without breaking build if deleted
let appletConfig: Record<string, string> = {};
try {
  const configs = import.meta.glob('/firebase-applet-config.json', { eager: true });
  const key = Object.keys(configs)[0];
  if (key && (configs[key] as any)?.default) {
    appletConfig = (configs[key] as any).default;
  }
} catch {
  // Config file not present, fallback to env vars or local-first
}

const firebaseConfig = {
  apiKey: appletConfig?.apiKey || import.meta.env.VITE_FIREBASE_API_KEY || '',
  authDomain: appletConfig?.authDomain || import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
  projectId: appletConfig?.projectId || import.meta.env.VITE_FIREBASE_PROJECT_ID || '',
  storageBucket: appletConfig?.storageBucket || import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || '',
  messagingSenderId: appletConfig?.messagingSenderId || import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
  appId: appletConfig?.appId || import.meta.env.VITE_FIREBASE_APP_ID || '',
  firestoreDatabaseId: appletConfig?.firestoreDatabaseId || '',
};

export const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey &&
  firebaseConfig.apiKey !== 'AIzaSyYourApiKeyHere' &&
  firebaseConfig.projectId &&
  firebaseConfig.projectId !== 'sipontren-demo'
);

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

if (isFirebaseConfigured) {
  try {
    app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = firebaseConfig.firestoreDatabaseId
      ? getFirestore(app, firebaseConfig.firestoreDatabaseId)
      : getFirestore(app);
  } catch (error) {
    console.warn('Gagal menginisialisasi Firebase SDK, beralih ke penyimpanan lokal super cepat:', error);
    app = null;
    auth = null;
    db = null;
  }
}

export { app, auth, db, firebaseConfig };
