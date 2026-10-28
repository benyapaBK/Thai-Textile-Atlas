import dotenv from 'dotenv';
import express from 'express';
import { createAdminRouter } from './admin.js';

dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const app = express();
const port = Number(process.env.API_PORT || 3001);

app.disable('x-powered-by');
app.use(createAdminRouter());

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Admin API listening on port ${port}`);
  if (process.send) process.send('ready');
});

server.on('error', error => {
  console.error('Unable to start the admin API:', error);
  process.exitCode = 1;
});
