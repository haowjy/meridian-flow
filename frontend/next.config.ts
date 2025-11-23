import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Transpile shiki to fix bundling issue with streamdown
  // Shiki is used by streamdown for syntax highlighting in chat markdown
  transpilePackages: ['shiki'],
} as NextConfig;

export default nextConfig;
