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
import { migrateLegacyPlanOnce } from "../lib/storage";
import { usePlanStore } from "../store/usePlanStore";
import { useBlockHistory } from "../store/useBlockHistory";
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
async function initialize() {
  await migrateFromCloudOnce(LEGACY_BASE, AbortSignal.timeout(8000)).catch(() => null);
  await migrateLegacyPlanOnce();
  await usePlanStore.getState().hydrate();
  await useBlockHistory.getState().hydrate();
  boot();
}

void initialize().catch((err: unknown) => {
  // Do not mount editable empty state over unreadable data. Retain all stored data for retry/export.
  const root = document.getElementById("root")!;
  const message = document.createElement("p");
  message.setAttribute("role", "alert");
  message.textContent = `本机计划加载失败，未清除任何数据。${err instanceof Error ? err.message : String(err)}`;
  const retry = document.createElement("button");
  retry.textContent = "重新加载";
  retry.onclick = () => window.location.reload();
  root.replaceChildren(message, retry);
});