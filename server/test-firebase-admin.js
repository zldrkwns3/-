import admin from 'firebase-admin';
import fs from 'fs';
const firebaseConfig = JSON.parse(fs.readFileSync('./firebase-applet-config.json', 'utf8'));

try {
  admin.initializeApp({
    projectId: firebaseConfig.projectId
  });
  
  const db = admin.firestore();
  if (firebaseConfig.firestoreDatabaseId && firebaseConfig.firestoreDatabaseId !== '(default)') {
    db.settings({ databaseId: firebaseConfig.firestoreDatabaseId });
  }

  await db.collection('test').doc('ping').set({ timestamp: Date.now() });
  console.log('Firebase admin initialized and wrote successfully');
} catch (error) {
  console.error('Failed:', error);
}
