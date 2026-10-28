import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import express from 'express';

const SESSION_COOKIE = 'thai_admin_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const entry = cookies.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
}

function getPasswordHash(passwordHash) {
  const value = passwordHash || '';
  const [, salt, digest] = value.split('$');
  if (!salt || !digest) return null;
  return { salt, digest: Buffer.from(digest, 'base64url') };
}

function passwordMatches(password, storedHash) {
  const candidate = scryptSync(password, storedHash.salt, storedHash.digest.length);
  return candidate.length === storedHash.digest.length && timingSafeEqual(candidate, storedHash.digest);
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`);
}

async function getSession(req, sessionStore) {
  const token = getCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const session = await sessionStore.get(token);
  if (!session) return null;
  if (Date.now() - session.lastSeenAt > SESSION_TTL_MS) {
    await sessionStore.delete(token);
    return null;
  }
  session.lastSeenAt = Date.now();
  await sessionStore.set(token, session);
  return { token, session };
}

function validateData(data) {
  return Boolean(data && Array.isArray(data.textiles) && data.textiles.length <= 10000 &&
    Array.isArray(data.resources) && data.resources.length <= 10000 &&
    data.siteConfig && typeof data.siteConfig === 'object' && !Array.isArray(data.siteConfig));
}

const AUDIT_SNAPSHOT_LIMIT = 150 * 1024;

function stableJson(value) {
  return JSON.stringify(value);
}

// Compares two site-data snapshots and lists every created, updated, or deleted record.
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
      else if (stableJson(oldItems.get(id)) !== stableJson(item)) {
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
    .filter(field => stableJson(oldConfig[field]) !== stableJson(newConfig[field]));
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

function buildAuditEntry(action, changes, req) {
  const summary = { create: 0, update: 0, delete: 0 };
  changes.forEach(change => { summary[change.op] += 1; });
  let stored = changes;
  if (stableJson(changes).length > AUDIT_SNAPSHOT_LIMIT) {
    stored = changes.map(({ kind, op, id, label }) => ({ kind, op, id, label, snapshotOmitted: true }));
  }
  return {
    at: new Date().toISOString(),
    action,
    actor: 'admin',
    ip: req.ip || req.socket?.remoteAddress || 'unknown',
    summary,
    changes: stored
  };
}

export function createAdminRouter({
  dataStore,
  sessionStore,
  loginAttemptStore,
  auditStore = null,
  getAdminPasswordHash = () => process.env.ADMIN_PASSWORD_HASH || ''
}) {
  const router = express.Router();
  router.use(express.json({ limit: '20mb' }));

  function requireAdmin(req, res, next) {
    getSession(req, sessionStore).then(session => {
      if (!session) {
        res.status(401).json({ error: 'กรุณาเข้าสู่ระบบผู้ดูแลระบบอีกครั้ง' });
        return;
      }
      next();
    }).catch(next);
  }

  function checkSameOrigin(req, res, next) {
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) {
          return res.status(403).json({ error: 'คำขอจากแหล่งที่มาไม่ถูกต้อง' });
        }
      } catch {
        return res.status(403).json({ error: 'คำขอจากแหล่งที่มาไม่ถูกต้อง' });
      }
    }
    next();
  }

  router.get('/api/data', async (_req, res, next) => {
    try {
      const data = await dataStore.read();
      let sanitized = false;
      if (data?.siteConfig && typeof data.siteConfig === 'object' && !Array.isArray(data.siteConfig)) {
        for (const [key, value] of Object.entries(data.siteConfig)) {
          if (typeof value === 'string' && value.includes('123456789')) {
            data.siteConfig[key] = value.replaceAll('123456789', 'รหัสผ่านที่กำหนดในระบบ');
            sanitized = true;
          }
        }
      }
      if (sanitized) await dataStore.write(data);
      res.json({ data });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/admin/session', async (req, res, next) => {
    try {
      res.json({ authenticated: Boolean(await getSession(req, sessionStore)) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/admin/login', checkSameOrigin, async (req, res, next) => {
    try {
      const storedHash = getPasswordHash(getAdminPasswordHash());
      if (!storedHash) return res.status(503).json({ error: 'ยังไม่ได้ตั้งค่ารหัสผ่านผู้ดูแลระบบบนเซิร์ฟเวอร์' });

      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const now = Date.now();
      if (await loginAttemptStore.isLimited(ip, now, LOGIN_WINDOW_MS, MAX_LOGIN_ATTEMPTS)) {
        return res.status(429).json({ error: 'ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่' });
      }

      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!passwordMatches(password, storedHash)) {
        const attempts = await loginAttemptStore.recordFailure(ip, now, LOGIN_WINDOW_MS);
        if (attempts >= MAX_LOGIN_ATTEMPTS) {
          return res.status(429).json({ error: 'ลองเข้าสู่ระบบหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่' });
        }
        return res.status(401).json({ error: 'รหัสผ่านไม่ถูกต้อง' });
      }

      await loginAttemptStore.clear(ip);
      const token = randomBytes(32).toString('base64url');
      await sessionStore.set(token, { lastSeenAt: now });
      setSessionCookie(res, token);
      if (auditStore) {
        await auditStore.append({ at: new Date().toISOString(), action: 'auth.login', actor: 'admin', ip, summary: {}, changes: [] }).catch(() => {});
      }
      res.json({ authenticated: true });
    } catch (error) {
      next(error);
    }
  });

  router.post('/api/admin/logout', checkSameOrigin, async (req, res, next) => {
    try {
      const activeSession = await getSession(req, sessionStore);
      if (activeSession) await sessionStore.delete(activeSession.token);
      clearSessionCookie(res);
      res.json({ authenticated: false });
    } catch (error) {
      next(error);
    }
  });

  router.put('/api/admin/data', checkSameOrigin, requireAdmin, async (req, res, next) => {
    try {
      if (!validateData(req.body)) {
        return res.status(400).json({ error: 'รูปแบบข้อมูลเว็บไซต์ไม่ถูกต้อง' });
      }
      const previous = auditStore ? await dataStore.read() : null;
      await dataStore.write(req.body);
      if (auditStore) {
        const changes = diffSiteData(previous, req.body);
        if (changes.length) {
          try {
            await auditStore.append(buildAuditEntry('data.update', changes, req));
          } catch (auditError) {
            console.error('[admin-api] Audit log failed:', auditError);
          }
        }
      }
      res.json({ saved: true });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/admin/audit', requireAdmin, async (req, res, next) => {
    try {
      if (!auditStore) return res.json({ entries: [] });
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);
      res.json({ entries: await auditStore.list(limit) });
    } catch (error) {
      next(error);
    }
  });

  router.use((error, _req, res, _next) => {
    console.error('[admin-api] Request failed:', error);
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    res.status(status).json({ error: status === 413 ? 'ข้อมูลเว็บไซต์มีขนาดใหญ่เกินกว่าที่ระบบจัดเก็บได้' : 'เกิดข้อผิดพลาดในการอ่านหรือบันทึกข้อมูลเว็บไซต์' });
  });

  return router;
}
