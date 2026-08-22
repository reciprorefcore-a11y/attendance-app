import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        {
          key: "Cache-Control",
          value: "public, max-age=3600, stale-while-revalidate=86400",
        },
      ],
    },
    {
      // API応答を1時間キャッシュすると給与計算の結果が古いまま返るため必ず無効化する。
      // （このルールは上の全体ルールより後に置くことで上書きさせている）
      source: "/api/:path*",
      headers: [{ key: "Cache-Control", value: "no-store" }],
    },
  ],
};

export default nextConfig;
