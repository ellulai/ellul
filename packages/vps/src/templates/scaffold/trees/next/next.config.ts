import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Permit the {{APP_ZONE}} preview domain to serve dev bundles — Next's
  // dev-origin check otherwise blocks requests whose Host header isn't
  // localhost. The same list is used by our Caddy dev-route generator.
  allowedDevOrigins: ['*.{{APP_ZONE}}'],
};

export default nextConfig;
