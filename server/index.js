import { createApp } from './app.js';

const port = Number(process.env.PORT) || 8080;
const host = process.env.HOST || '0.0.0.0';

const { server } = await createApp({
  dataDir: process.env.DATA_DIR,
  adminPassword: process.env.ADMIN_PASSWORD,
  publicUrl: process.env.PUBLIC_URL,
});

server.listen(port, host, () => {
  console.log(`[signage] listening on http://${host}:${port} — admin UI at /admin/`);
});
