import fs from 'node:fs';
import { createApp } from './app.js';

const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '0.0.0.0';
// Optional HTTPS: TLS_CERT / TLS_KEY point at PEM files.
const tls = process.env.TLS_CERT && process.env.TLS_KEY
  ? { cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }
  : null;

const { server } = await createApp({
  dataDir: process.env.DATA_DIR,
  adminPassword: process.env.ADMIN_PASSWORD,
  publicUrl: process.env.PUBLIC_URL,
  tls,
  mdns: process.env.MDNS !== 'off',
});

server.listen(port, host, () => {
  console.log(`[signage] listening on ${tls ? 'https' : 'http'}://${host}:${port} — admin UI at /admin/, add-on at /addon/`);
});
