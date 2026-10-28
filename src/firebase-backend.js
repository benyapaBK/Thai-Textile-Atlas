import { initializeApp } from 'firebase/app';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from 'firebase/auth';
import {
  collection, doc, getDoc, getDocs, getFirestore, limit, orderBy, query, writeBatch
} from 'firebase/firestore';

// Serverless backend: Firestore holds the data + audit log, Firebase Auth identifies the admin.
// Permissions are enforced by firestore.rules, not by this file.
if (import.meta.env.VITE_BACKEND === 'firebase') {
  const app = initializeApp({
    apiKey: 'AIzaSyAwPvOoZgzRF4ENXtr7LfKPiItxojAVCi8',
    authDomain: 'thai-textile-atlas.firebaseapp.com',
    projectId: 'thai-textile-atlas',
    storageBucket: 'thai-textile-atlas.firebasestorage.app',
    messagingSenderId: '785554596938',
    appId: '1:785554596938:web:45c6b8d9a1539702a0b2b3'
  });
  const auth = getAuth(app);
  const db = getFirestore(app);

  const ADMIN_EMAIL = 'admin@thai-textile-atlas.app';
  const AUDIT_SNAPSHOT_LIMIT = 150 * 1024;
  const siteRef = doc(db, 'site', 'data');
  const authReady = new Promise(resolve => {
    const off = onAuthStateChanged(auth, () => { off(); resolve(); });
  });

  const isAdminUser = () => auth.currentUser?.email === ADMIN_EMAIL;
  const fail = (message, status = 400) => Object.assign(new Error(message), { status });
  const json = value => JSON.stringify(value);

  function diffSiteData(before, after) {
    const changes = [];
    const collections = [
      ['textile', 'textiles', item => item.nameTh || item.nameEn || item.id],
      ['resource', 'resources', item => item.title || item.id]
    ];
    for (const [kind, key, labelOf] of collections) {
      const oldItems = new Map((Array.isArray(before?.[key]) ? before[key] : []).map(item => [item?.id, item]));
      const newItems = new Map((Array.isArray(after?.[key]) ? after[key] : []).map(item => [item?.id, item]));
      for (const [id, item] of newItems) {
        if (!oldItems.has(id)) changes.push({ kind, op: 'create', id, label: labelOf(item), after: item });
        else if (json(oldItems.get(id)) !== json(item)) {
          changes.push({ kind, op: 'update', id, label: labelOf(item), before: oldItems.get(id), after: item });
        }
      }
      for (const [id, item] of oldItems) {
        if (!newItems.has(id)) changes.push({ kind, op: 'delete', id, label: labelOf(item), before: item });
      }
    }
    const oldConfig = before?.siteConfig || {};
    const newConfig = after?.siteConfig || {};
    const fields = [...new Set([...Object.keys(oldConfig), ...Object.keys(newConfig)])]
      .filter(field => json(oldConfig[field]) !== json(newConfig[field]));
    if (fields.length) {
      changes.push({
        kind: 'siteConfig',
        op: 'update',
        id: 'siteConfig',
        label: `เนื้อหาเว็บไซต์ (${fields.length} ช่อง)`,
        before: Object.fromEntries(fields.map(field => [field, oldConfig[field] ?? null])),
        after: Object.fromEntries(fields.map(field => [field, newConfig[field] ?? null]))
      });
    }
    return changes;
  }

  function auditDoc(action, changes) {
    const summary = { create: 0, update: 0, delete: 0 };
    changes.forEach(change => { summary[change.op] += 1; });
    let stored = changes;
    if (json(changes).length > AUDIT_SNAPSHOT_LIMIT) {
      stored = changes.map(({ kind, op, id, label }) => ({ kind, op, id, label, snapshotOmitted: true }));
    }
    return {
      at: new Date().toISOString(),
      action,
      actor: auth.currentUser?.email || 'admin',
      summary: json(summary),
      payload: json({ summary, changes: stored })
    };
  }

  const loginMessage = code => ({
    'auth/invalid-credential': 'รหัสผ่านไม่ถูกต้อง',
    'auth/wrong-password': 'รหัสผ่านไม่ถูกต้อง',
    'auth/user-not-found': 'ยังไม่ได้สร้างบัญชีผู้ดูแลระบบ',
    'auth/too-many-requests': 'ลองผิดหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่',
    'auth/network-request-failed': 'เชื่อมต่อเครือข่ายไม่ได้'
  }[code] || 'เข้าสู่ระบบไม่สำเร็จ');

  async function readData() {
    const snap = await getDoc(siteRef);
    return snap.exists() ? JSON.parse(snap.data().payload) : null;
  }

  async function request(url, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const path = url.split('?')[0];
    await authReady;

    if (path === '/api/data' && method === 'GET') return { data: await readData() };

    if (path === '/api/admin/session') return { authenticated: isAdminUser() };

    if (path === '/api/admin/login') {
      const { password } = JSON.parse(options.body || '{}');
      try {
        await signInWithEmailAndPassword(auth, ADMIN_EMAIL, String(password || ''));
      } catch (error) {
        throw fail(loginMessage(error.code), 401);
      }
      try {
        const batch = writeBatch(db);
        batch.set(doc(collection(db, 'auditLogs')), auditDoc('auth.login', []));
        await batch.commit();
      } catch (error) {
        console.warn('Unable to record login in audit log:', error);
      }
      return { authenticated: true };
    }

    if (path === '/api/admin/logout') {
      await signOut(auth);
      return { authenticated: false };
    }

    if (path === '/api/admin/data' && method === 'PUT') {
      if (!isAdminUser()) throw fail('กรุณาเข้าสู่ระบบผู้ดูแลระบบอีกครั้ง', 401);
      const next = JSON.parse(options.body);
      const before = await readData();
      const batch = writeBatch(db);
      batch.set(siteRef, { payload: json(next), updatedAt: new Date().toISOString() });
      const changes = diffSiteData(before, next);
      if (changes.length) batch.set(doc(collection(db, 'auditLogs')), auditDoc('data.update', changes));
      try {
        await batch.commit();
      } catch (error) {
        throw fail(error.code === 'permission-denied' ? 'ไม่มีสิทธิ์บันทึกข้อมูล' : 'บันทึกข้อมูลไม่สำเร็จ', 403);
      }
      return { ok: true };
    }

    if (path === '/api/admin/audit') {
      if (!isAdminUser()) throw fail('กรุณาเข้าสู่ระบบอีกครั้ง', 401);
      const snap = await getDocs(query(collection(db, 'auditLogs'), orderBy('at', 'desc'), limit(100)));
      return {
        entries: snap.docs.map(d => {
          const data = d.data();
          const parsed = JSON.parse(data.payload);
          return { id: d.id, at: data.at, action: data.action, actor: data.actor, ...parsed };
        })
      };
    }

    throw fail('ไม่พบบริการที่ร้องขอ', 404);
  }

  window.firebaseBackend = { request };
}
