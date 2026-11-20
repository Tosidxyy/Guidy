import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useUiStore } from '@/store/useUiStore';

export function FeedbackDialog() {
  const open = useUiStore((s) => s.drawer === 'feedback');
  const closeDrawer = useUiStore((s) => s.closeDrawer);
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) closeDrawer(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">反馈与问题收集</DialogTitle>
          <DialogDescription>扫码打开 Guidy Bug 反馈表，或分享给好友。</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-center py-2">
          <img src="/brand/feedback-qr.png" alt="Guidy Bug 反馈表二维码" className="w-64 rounded-[var(--site-radius-card)]" />
        </div>
        <p className="text-center text-xs text-site-ink-soft">腾讯文档 · 可多人实时在线编辑，权限安全可控</p>
      </DialogContent>
    </Dialog>
  );
}