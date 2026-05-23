/// <reference types="vite/client" />

interface EllulConfig {
  platformZone: string;
  appZone: string;
  consoleOrigin: string;
  wsOrigin?: string;
  codeWsOrigin?: string;
  codeWsPath?: string;
}

interface Window {
  __ELLUL_CONFIG__?: EllulConfig;
}
