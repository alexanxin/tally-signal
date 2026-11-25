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
      {
        // Tally's private balance kill switch: read by the app on every mainnet deposit or
        // send. Set a value to false and redeploy to pause it for everyone. Never cached.
        source: "/spr-status.json",
        headers: [
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
    ];
  },
  async rewrites() {
    return [
      { source: "/deck", destination: "/deck.html" },
    ];
  },
};

export default nextConfig;
