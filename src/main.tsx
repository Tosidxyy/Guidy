import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/500.css";
import "@fontsource/space-grotesk/600.css";
import "@fontsource/space-grotesk/700.css";
import App from "./App";
import { queryClient } from "../lib/queryClient";
import { LEGACY_BASE } from "../lib/api";
import { migrateFromCloudOnce } from "../lib/local/domain";
import "./globals.css";

function boot() {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

// 首次打开：把旧云端的一次性数据搬到本机；之后所有读写都只在本机（AI 走无状态代理）。
migrateFromCloudOnce(LEGACY_BASE, AbortSignal.timeout(8000)).catch(() => null).finally(boot);