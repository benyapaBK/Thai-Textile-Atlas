import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostingUrl = (process.argv[2] || 'https://thai-textile-atlas.web.app').replace(/\/+$/, '');
const dataPath = path.resolve(root, process.argv[3] || '.data/site-data.json');
const password = process.env.ADMIN_PASSWORD;

if (!password) {
  console.error('Set ADMIN_PASSWORD in the environment before running this migration.');
  process.exitCode = 1;
} else {
  const data = JSON.parse(await readFile(dataPath, 'utf8'));
  const loginResponse = await fetch(`${hostingUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  });
  const loginResult = await loginResponse.json().catch(() => ({}));
  if (!loginResponse.ok) {
    throw new Error(`Firebase admin login failed (${loginResponse.status}): ${loginResult.error || 'Unknown error'}`);
  }

  const cookie = loginResponse.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('Firebase admin API did not issue an admin session cookie.');

  try {
    const saveResponse = await fetch(`${hostingUrl}/api/admin/data`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie
      },
      body: JSON.stringify(data)
    });
    const saveResult = await saveResponse.json().catch(() => ({}));
    if (!saveResponse.ok) {
      throw new Error(`Firebase data migration failed (${saveResponse.status}): ${saveResult.error || 'Unknown error'}`);
    }
    console.log(`Migrated ${data.textiles.length} textile records and ${data.resources.length} resources to Firebase.`);
  } finally {
    await fetch(`${hostingUrl}/api/admin/logout`, {
      method: 'POST',
      headers: { Cookie: cookie }
    });
  }
}
