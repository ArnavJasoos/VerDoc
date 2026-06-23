/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Transpile the shared workspace package (ships as TS source).
  transpilePackages: ["@verdoc/db"],
};

export default nextConfig;
