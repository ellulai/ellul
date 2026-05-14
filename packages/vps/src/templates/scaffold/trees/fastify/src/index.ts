import Fastify from 'fastify';

const app = Fastify({ logger: true });

app.get('/', async () => ({ message: 'Your app is ready.', powered: 'ellul' }));
app.get('/api/health', async () => ({ ok: true }));

const port = Number(process.env.PORT) || 3000;
app.listen({ port, host: '0.0.0.0' }, (err, addr) => {
  if (err) { app.log.error(err); process.exit(1); }
  app.log.info(`Listening on ${addr}`);
});
