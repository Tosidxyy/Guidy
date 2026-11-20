import { toast } from 'sonner';
import { Copy, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useUiStore } from '@/store/useUiStore';

const FEEDBACK_URL = 'https://docs.qq.com/form/page/DZERWZk1zRG5VemF4';

export function FeedbackDialog() {
  const open = useUiStore((s) => s.drawer === 'feedback');
  const closeDrawer = useUiStore((s) => s.closeDrawer);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(FEEDBACK_URL);
      toast.success('反馈表链接已复制');
    } catch {
      const ta = document.createElement('textarea');
      ta.value = FEEDBACK_URL;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) toast.success('反馈表链接已复制');
      else toast.error('复制失败，请手动复制链接');
    }
  };
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) closeDrawer(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="font-display">反馈与问题收集</DialogTitle>
          <DialogDescription>扫码或打开链接填写 Guidy Bug 反馈表，也可以复制分享给好友。</DialogDescription>
        </DialogHeader>
        <div className="flex items-center justify-center py-2">
          <img src="/brand/feedback-qr.png" alt="Guidy Bug 反馈表二维码" className="w-56 rounded-[var(--site-radius-card)] border border-site-line bg-white p-2" />
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="flex-1" onClick={() => { void copyLink(); }}>
            <Copy className="mr-1.5 h-4 w-4" /> 复制链接
          </Button>
          <Button variant="outline" className="flex-1" asChild>
            <a href={FEEDBACK_URL} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-1.5 h-4 w-4" /> 新标签打开
            </a>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}