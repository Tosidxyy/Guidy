import { useUiStore } from '@/store/useUiStore';

export function PrivacyFooter() {
  const openDrawer = useUiStore((s) => s.openDrawer);
  return (
    <footer className="shrink-0 border-t border-site-line bg-site-surface px-3 py-1.5 text-center text-[11px] leading-relaxed text-site-ink-soft">
      匿名收集：仅计划与对话内容，不收集邮箱/手机号。清缓存或换设备前请导出 JSON 或生成恢复码。
      <button type="button" className="ml-2 underline underline-offset-2 hover:text-site-ink" onClick={() => openDrawer('settings')}>
        删除我的全部数据
      </button>
    </footer>
  );
}