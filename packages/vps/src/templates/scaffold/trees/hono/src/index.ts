import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const app = new Hono();

app.get('/', (c) => c.json({ message: 'Your app is ready.', powered: 'ellul' }));
app.get('/api/health', (c) => c.json({ ok: true }));

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
  console.log(`Listening on http://0.0.0.0:${info.port}`);
});
