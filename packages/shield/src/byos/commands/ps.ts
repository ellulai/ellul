import { fail, success, EXIT, isJsonMode } from '../../lib/output';
import { engineCall } from '../../lib/engine-client';

interface ServiceInfo {
  name: string;
  active: boolean;
  pid: number;
  port: number;
  memory: string;
}

export async function handlePs(_args: string[]): Promise<void> {
  let result: { uptime: number; services?: Record<string, { active: boolean; pid?: number; port?: number; memory?: string }> };
  try {
    result = (await engineCall('status')) as typeof result;
  } catch (e: unknown) {
    fail(EXIT.NETWORK, 'ps', `Engine error: ${e instanceof Error ? e.message : e}`, 'Is the workspace running? Start with: ellul up');
  }

  let projects: Array<{ slug: string; path: string; status: string }> = [];
  try {
    projects = (await engineCall('project.list')) as typeof projects;
  } catch {}

  if (isJsonMode()) {
    success({ services: result.services, projects, uptime: result.uptime });
    return;
  }

  const services: ServiceInfo[] = [];
  if (result.services) {
    for (const [name, svc] of Object.entries(result.services)) {
      services.push({
        name,
        active: svc.active,
        pid: svc.pid || 0,
        port: svc.port || 0,
        memory: svc.memory || '-',
      });
    }
  }

  process.stderr.write(`\nServices (uptime: ${result.uptime}s)\n`);
  if (services.length === 0) {
    process.stderr.write('  No services running.\n');
  } else {
    const header = ['SERVICE', 'STATUS', 'PID', 'PORT', 'MEMORY'];
    const rows = services.map((s) => [
      s.name,
      s.active ? 'running' : 'stopped',
      String(s.pid || '-'),
      String(s.port || '-'),
      s.memory,
    ]);

    const widths = header.map((h, i) =>
      Math.max(h.length, ...rows.map((r) => r[i]!.length)),
    );

    const fmt = (cells: string[]) =>
      cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');

    process.stderr.write('  ' + fmt(header) + '\n');
    process.stderr.write(
      '  ' + widths.map((w) => '─'.repeat(w)).join('  ') + '\n',
    );
    for (const row of rows) {
      process.stderr.write('  ' + fmt(row) + '\n');
    }
  }

  if (projects.length > 0) {
    process.stderr.write('\nProjects\n');
    for (const p of projects) {
      const sym = p.status === 'running' ? '✓' : '·';
      process.stderr.write(`  ${sym} ${p.slug}  ${p.path}  [${p.status}]\n`);
    }
  }

  process.stderr.write('\n');
}
