/** @type {import('next').NextConfig} */
const API_ORIGIN = process.env.API_ORIGIN || "http://localhost:3001";

const nextConfig = {
  async rewrites() {
    return [
      { source: "/stt", destination: `${API_ORIGIN}/stt` },
      { source: "/config", destination: `${API_ORIGIN}/config` },
      { source: "/health", destination: `${API_ORIGIN}/health` },
      { source: "/languages", destination: `${API_ORIGIN}/languages` },
      { source: "/languages/:path*", destination: `${API_ORIGIN}/languages/:path*` },
      { source: "/approve", destination: `${API_ORIGIN}/approve` },
      { source: "/llm-test", destination: `${API_ORIGIN}/llm-test` },
    ];
  },
};

module.exports = nextConfig;
