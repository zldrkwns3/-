import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc } from 'firebase/firestore';
import fs from 'fs';

let db: any = null;

try {
  const firebaseConfig = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
  console.log("🔥 Firebase Firestore Web SDK initialized.");
} catch (e) {
  console.error("Failed to initialize Firebase Web SDK:", e);
}

export async function saveSnapshotToFirestore(snapshot: {
  date: string;
  totalEquity: number;
  operationPool: number;
  safeVault: number;
}) {
  if (!db) {
    console.warn("Firestore not initialized, skipping snapshot save.");
    return;
  }
  try {
    const docRef = doc(db, 'bot_history', snapshot.date);
    await setDoc(docRef, snapshot);
    console.log(`✅ Snapshot for ${snapshot.date} successfully saved to Firestore.`);
  } catch (e) {
    console.error("❌ Failed to save snapshot to Firestore:", e);
  }
}
