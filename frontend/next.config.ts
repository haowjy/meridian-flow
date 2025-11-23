import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Transpile shiki to fix bundling issue with streamdown
  // Shiki is used by streamdown for syntax highlighting in chat markdown
  transpilePackages: ['shiki'],

  // Enable standalone output for Docker deployment
  // This creates a minimal production build with only necessary files
  output: 'standalone',
} as NextConfig;

export default nextConfig;
