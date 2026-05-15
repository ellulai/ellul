import { fail, EXIT } from '../../lib/output';

export async function handleByosCommand(args: string[]): Promise<void> {
  const command = args[0] || '';

  switch (command) {
    case 'up': {
      const { handleUp } = await import('./up');
      await handleUp(args.slice(1));
      break;
    }

    case 'down': {
      const { handleDown } = await import('./down');
      await handleDown(args.slice(1));
      break;
    }

    case 'ps': {
      const { handlePs } = await import('./ps');
      await handlePs(args.slice(1));
      break;
    }

    case 'logs': {
      const { handleLogs } = await import('./logs');
      await handleLogs(args.slice(1));
      break;
    }

    case 'config': {
      const { handleConfig } = await import('./config');
      await handleConfig(args.slice(1));
      break;
    }

    case 'init': {
      const { handleInit } = await import('./init');
      await handleInit(args.slice(1));
      break;
    }

    case 'upgrade': {
      const { handleUpgrade } = await import('./upgrade');
      await handleUpgrade(args.slice(1));
      break;
    }

    case 'uninstall': {
      const { handleUninstall } = await import('./uninstall');
      await handleUninstall(args.slice(1));
      break;
    }

    case 'expose': {
      const { handleExpose } = await import('./expose');
      await handleExpose(args.slice(1));
      break;
    }

    case 'connect': {
      const { handleConnect } = await import('./connect');
      await handleConnect(args.slice(1));
      break;
    }

    case 'migrate': {
      const { handleMigrate } = await import('./migrate');
      await handleMigrate(args.slice(1));
      break;
    }

    default:
      fail(EXIT.USAGE, command || 'help', `Unknown command: ${command}`, "Run 'ellul help' for usage.");
  }
}
