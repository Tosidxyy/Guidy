import { useUiStore } from '@/store/useUiStore';

export function PrivacyFooter() {
  const openDrawer = useUiStore((s) => s.openDrawer);
  return (
    <footer className="shrink-0 border-t border-site-line bg-site-surface px-3 py-1.5 text-center text-xs leading-relaxed text-site-ink-soft">
      数据只保存在本机浏览器（IndexedDB）。清除站点数据或换设备会丢失，请先导出 JSON 备份。
      <button type="button" className="ml-2 underline underline-offset-2 hover:text-site-ink" onClick={() => openDrawer('settings')}>
        删除我的全部数据
      </button>
    </footer>
  );
}