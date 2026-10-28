import { createHash } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { onRequest } from 'firebase-functions/v2/https';
import express from 'express';
import { createAdminRouter } from './src/admin-api.js';

const ADMIN_PASSWORD_HASH = defineSecret('ADMIN_PASSWORD_HASH');
const MAX_FIRESTORE_DOCUMENT_BYTES = 900 * 1024;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

initializeApp();

const firestore = getFirestore();
const siteDataDocument = firestore.collection('siteData').doc('current');
const sessions = firestore.collection('adminSessions');
const loginAttempts = firestore.collection('adminLoginAttempts');
const auditLogs = firestore.collection('auditLogs');

// Entries are stored as a JSON string so arbitrary record shapes never hit Firestore field restrictions.
const auditStore = {
  async append(entry) {
    await auditLogs.add({ at: entry.at, payload: JSON.stringify(entry) });
  },
  async list(limit) {
    const snapshot = await auditLogs.orderBy('at', 'desc').limit(limit).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...JSON.parse(doc.get('payload')) }));
  }
};

function documentId(value) {
  return createHash('sha256').update(value).digest('hex');
}

const dataStore = {
  async read() {
    const snapshot = await siteDataDocument.get();
    return snapshot.exists ? snapshot.get('data') : null;
  },
  async write(data) {
    const payload = JSON.stringify(data);
    if (Buffer.byteLength(payload, 'utf8') > MAX_FIRESTORE_DOCUMENT_BYTES) {
      const error = new Error('Site data exceeds the Firestore document size limit');
      error.status = 413;
      throw error;
    }
    await siteDataDocument.set({
      data,
      updatedAt: FieldValue.serverTimestamp()
    });
  }
};

const sessionStore = {
  async get(token) {
    const reference = sessions.doc(documentId(token));
    const snapshot = await reference.get();
    if (!snapshot.exists) return null;
    const session = snapshot.data();
    return {
      lastSeenAt: session.lastSeenAt.toMillis()
    };
  },
  async set(token, session) {
    await sessions.doc(documentId(token)).set({
      lastSeenAt: Timestamp.fromMillis(session.lastSeenAt),
      expiresAt: Timestamp.fromMillis(Date.now() + SESSION_TTL_MS)
    });
  },
  async delete(token) {
    await sessions.doc(documentId(token)).delete();
  }
};

const loginAttemptStore = {
  async isLimited(ip, now, windowMs, maxAttempts) {
    const reference = loginAttempts.doc(documentId(ip));
    return firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      if (!snapshot.exists) return false;
      const attempt = snapshot.data();
      if (now - attempt.startedAtMs > windowMs) return false;
      return attempt.count >= maxAttempts;
    });
  },
  async recordFailure(ip, now, windowMs) {
    const reference = loginAttempts.doc(documentId(ip));
    return firestore.runTransaction(async transaction => {
      const snapshot = await transaction.get(reference);
      const previous = snapshot.exists ? snapshot.data() : null;
      const attempt = !previous || now - previous.startedAtMs > windowMs
        ? { count: 0, startedAtMs: now }
        : previous;
      attempt.count += 1;
      transaction.set(reference, {
        count: attempt.count,
        startedAtMs: attempt.startedAtMs,
        expiresAt: Timestamp.fromMillis(attempt.startedAtMs + windowMs)
      });
      return attempt.count;
    });
  },
  async clear(ip) {
    await loginAttempts.doc(documentId(ip)).delete();
  }
};

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(createAdminRouter({
  dataStore,
  auditStore,
  sessionStore,
  loginAttemptStore,
  getAdminPasswordHash: () => ADMIN_PASSWORD_HASH.value()
}));

export const api = onRequest({
  region: 'asia-southeast3',
  maxInstances: 5,
  memory: '256MiB',
  timeoutSeconds: 60,
  secrets: [ADMIN_PASSWORD_HASH]
}, app);
