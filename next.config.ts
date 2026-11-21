import type {NextConfig} from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: false,
  },
  // Allow access to remote image placeholder.
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'picsum.photos',
        port: '',
        pathname: '/**', // This allows any path under the hostname
      },
    ],
  },
  output: 'standalone',
  transpilePackages: ['motion'],
  async rewrites() {
    const ingestionBase = (
      process.env.INGESTION_INTERNAL_URL || 'http://127.0.0.1:4000'
    ).replace(/\/+$/, '');
    return [
      {
        source: '/vcon/files-engine',
        destination: `${ingestionBase}/vcon/files-engine`,
      },
      {
        source: '/vcon/files-engine/:path*',
        destination: `${ingestionBase}/vcon/files-engine/:path*`,
      },
      {
        source: '/mcp',
        destination: `${ingestionBase}/mcp`,
      },
      {
        source: '/mcp/:path*',
        destination: `${ingestionBase}/mcp/:path*`,
      },
    ];
  },
  webpack: (config, {dev}) => {
    // HMR is disabled in AI Studio via DISABLE_HMR env var.
    // Do not modify—file watching is disabled to prevent flickering during agent edits.
    if (dev && process.env.DISABLE_HMR === 'true') {
      config.watchOptions = {
        ignored: /.*/,
      };
    }
    return config;
  },
};

export default nextConfig;
