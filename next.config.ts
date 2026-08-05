import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  agentRules: false,
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
