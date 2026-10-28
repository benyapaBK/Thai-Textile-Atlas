import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import { createAdminRouter } from './admin.js';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.use(createAdminRouter());
app.use(express.static(path.resolve(root, '..', 'dist')));
app.get('*', (_req, res) => res.sendFile(path.resolve(root, '..', 'dist', 'index.html')));

app.listen(port, process.env.HOST || '0.0.0.0', () => {
  console.log(`Thai Textile Atlas server listening on port ${port}`);
});
