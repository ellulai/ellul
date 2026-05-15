import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from '../../lib/flags';
import { info, fail, status, success, EXIT } from '../../lib/output';
import { registerCommand, showCommandHelp } from '../../lib/help';
import { engineCall, isEngineReachable } from '../../lib/engine-client';

registerCommand({
  name: 'init',
  summary: 'Register project with engine',
  usage: 'ellul init [path]',
  examples: ['ellul init', 'ellul init ./my-app', 'ellul init --json'],
});

export async function handleInit(args: string[]): Promise<void> {
  const parsed = parseArgs(args);
  if (parsed.has('help')) {
    showCommandHelp('init');
    process.exit(0);
  }
  const targetPath = parsed.positional[0]
    ? path.resolve(parsed.positional[0])
    : process.cwd();

  if (!isEngineReachable()) {
    fail(EXIT.NETWORK, 'init', 'Engine not running.', 'Start workspace first: ellul up');
  }

  const metaPath = path.join(targetPath, '.ellul', 'project.json');
  if (fs.existsSync(metaPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (existing.projectSlug || existing.slug) {
        fail(
          EXIT.CONFLICT,
          'init',
          `Already initialized as ${existing.projectSlug || existing.slug}.`,
        );
      }
    } catch {}
  }

  if (!fs.existsSync(targetPath)) {
    fail(EXIT.USAGE, 'init', `Path does not exist: ${targetPath}`);
  }

  const projectName = path.basename(targetPath);
  info('init', `Registering project at ${targetPath}...`);

  let result: { slug: string };
  try {
    result = (await engineCall('project.register', {
      path: targetPath,
      name: projectName,
    })) as typeof result;
  } catch (e: unknown) {
    fail(
      EXIT.NETWORK,
      'init',
      `Failed to register project: ${e instanceof Error ? e.message : e}`,
    );
  }

  const slug = result.slug;

  fs.mkdirSync(path.join(targetPath, '.ellul'), { recursive: true });
  fs.writeFileSync(
    metaPath,
    JSON.stringify(
      {
        projectSlug: slug,
        projectName,
        mode: 'byos',
        path: targetPath,
      },
      null,
      2,
    ) + '\n',
  );

  status('✓', `Project registered: ${slug}`);
  success({ slug, path: targetPath });
}
