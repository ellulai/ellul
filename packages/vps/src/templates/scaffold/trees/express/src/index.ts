import express from 'express';

const app = express();

app.get('/', (_req, res) => {
  res.json({ message: 'Your app is ready.', powered: 'ellul' });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => {
  console.log(`Listening on http://0.0.0.0:${port}`);
});
