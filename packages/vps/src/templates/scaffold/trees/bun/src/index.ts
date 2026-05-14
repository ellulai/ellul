const port = Number(process.env.PORT) || 3000;

Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/api/health') {
      return Response.json({ ok: true });
    }
    return Response.json({ message: 'Your app is ready.', powered: 'ellul' });
  },
});

console.log(`Listening on http://0.0.0.0:${port}`);
