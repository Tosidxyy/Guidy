import { Sparkles } from 'lucide-react';

export function ArtifactGenerating() {
  return (
    <div className="flex items-center gap-1.5 text-xs text-site-ink-soft" role="status" aria-live="polite">
      <Sparkles className="h-3.5 w-3.5 animate-guidy-breathe text-site-brand" aria-hidden="true" />
      <span className="animate-guidy-breathe">正在生成方案…</span>
    </div>
  );
}