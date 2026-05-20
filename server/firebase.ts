import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, getDoc } from 'firebase/firestore';
import fs from 'fs';

export type MemoryData = {
  watchList: [string, any][];
  positions: [string, any][];
  availableCapital: number;
  safeReserve: number;
  totalEquity: number;
  isRunning: boolean;
  journals: any[];
  orders: any[];
  history: any[];
  lessons: string;
  logs: string[];
};

let db: any = null;

try {
  const firebaseConfig = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
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

export async function saveTradeToFirestore(trade: {
  symbol: string;
  name?: string;
  qty?: number;
  buyPrice: number;
  sellPrice: number;
  profitRate: number;
  profitAmount?: number;
  strategyName?: string;
  holdTimeMinutes?: number;
  maxPaperProfit?: number;
  review: string;
  date: number;
}) {
  if (!db) return;
  try {
    const docRef = doc(db, 'trades', `${trade.symbol}_${trade.date}`);
    await setDoc(docRef, trade);
  } catch (e) {
    console.error("❌ Failed to save trade to Firestore:", e);
  }
}

export async function saveLessonsToFirestore(lessons: string) {
  if (!db) return;
  try {
    const docRef = doc(db, 'bot_config', 'lessons');
    await setDoc(docRef, { lessons, updatedAt: Date.now() });
  } catch (e) {
    console.error("❌ Failed to save lessons to Firestore:", e);
  }
}

export async function getLessonsFromFirestore(): Promise<string> {
  if (!db) return "";
  try {
    const docRef = doc(db, 'bot_config', 'lessons');
    const snap = await getDoc(docRef);
    if (snap.exists()) return (snap.data() as any).lessons || "";
    return "";
  } catch (e) {
    console.error("❌ Failed to get lessons from Firestore:", e);
    return "";
  }
}

export async function saveMemoryToFirestore(data: MemoryData): Promise<void> {
  if (!db) return;
  try {
    const docRef = doc(db, 'bot_state', 'memory');
    await setDoc(docRef, { ...data, savedAt: Date.now() });
  } catch (e) {
    console.error("❌ Firestore 메모리 저장 실패:", e);
  }
}

export async function loadMemoryFromFirestore(): Promise<MemoryData | null> {
  if (!db) return null;
  try {
    const docRef = doc(db, 'bot_state', 'memory');
    const snap = await getDoc(docRef);
    if (!snap.exists()) return null;
    const data = snap.data() as any;
    return {
      watchList: data.watchList || [],
      positions: data.positions || [],
      availableCapital: data.availableCapital || 5000000,
      safeReserve: data.safeReserve || 0,
      totalEquity: data.totalEquity || 0,
      isRunning: data.isRunning || false,
      journals: data.journals || [],
      orders: data.orders || [],
      history: data.history || [],
      lessons: data.lessons || "",
      logs: (data.logs || []).slice(-200),
    };
  } catch (e) {
    console.error("❌ Firestore 메모리 로드 실패:", e);
    return null;
  }
}
