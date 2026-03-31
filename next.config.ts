import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['pdfkit', 'pdfjs-dist'],
};

export default nextConfig;
