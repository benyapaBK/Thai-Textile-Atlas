import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { createAdminRouter as createSharedAdminRouter } from '../functions/src/admin-api.js';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const dataFile = path.resolve(process.env.DATA_DIR || '.data', 'site-data.json');
const auditFile = path.resolve(process.env.DATA_DIR || '.data', 'audit-log.json');
const MAX_AUDIT_ENTRIES = 500;
let auditQueue = Promise.resolve();

async function readAudit() {
  try {
    const parsed = JSON.parse(await readFile(auditFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

const auditStore = {
  append(entry) {
    auditQueue = auditQueue.then(async () => {
      const entries = await readAudit();
      entries.push({ id: randomBytes(8).toString('hex'), ...entry });
      await mkdir(path.dirname(auditFile), { recursive: true });
      const temporaryFile = `${auditFile}.${randomBytes(8).toString('hex')}.tmp`;
      await writeFile(temporaryFile, JSON.stringify(entries.slice(-MAX_AUDIT_ENTRIES)), { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryFile, auditFile);
    });
    return auditQueue.catch(error => { auditQueue = Promise.resolve(); throw error; });
  },
  async list(limit) {
    return (await readAudit()).reverse().slice(0, limit);
  }
};
const sessions = new Map();
const loginAttempts = new Map();

async function readData() {
  try {
    return JSON.parse(await readFile(dataFile, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeData(data) {
  const directory = path.dirname(dataFile);
  await mkdir(directory, { recursive: true });
  const temporaryFile = `${dataFile}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
  await rename(temporaryFile, dataFile);
}

export function createAdminRouter() {
  return createSharedAdminRouter({
    auditStore,
    dataStore: {
      read: readData,
      write: writeData
    },
    sessionStore: {
      async get(token) {
        return sessions.get(token) || null;
      },
      async set(token, session) {
        sessions.set(token, session);
      },
      async delete(token) {
        sessions.delete(token);
      }
    },
    loginAttemptStore: {
      async isLimited(ip, now, windowMs, maxAttempts) {
        const attempt = loginAttempts.get(ip);
        if (!attempt || now - attempt.startedAt > windowMs) {
          loginAttempts.set(ip, { count: 0, startedAt: now });
          return false;
        }
        return attempt.count >= maxAttempts;
      },
      async recordFailure(ip, now, windowMs) {
        let attempt = loginAttempts.get(ip);
        if (!attempt || now - attempt.startedAt > windowMs) {
          attempt = { count: 0, startedAt: now };
          loginAttempts.set(ip, attempt);
        }
        attempt.count += 1;
        return attempt.count;
      },
      async clear(ip) {
        loginAttempts.delete(ip);
      }
    }
  });
}
