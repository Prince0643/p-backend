import type { NextConfig } from "next";

// The Express backend (PayMongo, GHL, webhooks, Postgres) stays exactly as-is.
// This proxies /api/* to it so client fetch('/api/...') calls work unchanged
// from the vanilla-JS admin pages this replaces, with zero CORS setup.
const EXPRESS_API_URL =
  process.env.EXPRESS_API_URL ||
  (process.env.NODE_ENV === "production" ? "http://localhost:3000" : "http://localhost:4123");
const isStaticExport = process.env.NEXT_OUTPUT_EXPORT === "true";

const nextConfig: NextConfig = {
  output: isStaticExport ? "export" : undefined,
  // Silences the workspace-root warning caused by the parent p-backend
  // package-lock.json sitting one directory up from this Next.js app.
  turbopack: {
    root: __dirname,
  },
  ...(isStaticExport
    ? {}
    : {
        async rewrites() {
          return [
            {
              source: "/api/:path*",
              destination: `${EXPRESS_API_URL}/api/:path*`,
            },
          ];
        },
      }),
};

export default nextConfig;
