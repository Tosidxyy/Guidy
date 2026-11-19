import { Loader2 } from 'lucide-react';

export function ArtifactGenerating() {
  return (
    <div className="flex items-center gap-1.5 text-xs text-site-ink-soft" role="status" aria-live="polite">
      <Loader2 className="h-3.5 w-3.5 animate-spin text-site-ink" aria-hidden="true" />
      <span>正在生成方案…</span>
    </div>
  );
}