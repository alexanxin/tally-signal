/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow the API route to be called cross-origin (agent running locally)
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          { key: "Access-Control-Allow-Headers", value: "Content-Type, X-Tally-Session" },
        ],
      },
    ];
  },
};

export default nextConfig;
