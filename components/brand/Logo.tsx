export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="guidy-dawn" x1="4" y1="26" x2="28" y2="6" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFB86B" />
          <stop offset="0.45" stopColor="#FF7E5F" />
          <stop offset="1" stopColor="#6A5AE0" />
        </linearGradient>
      </defs>
      <path d="M8 20a8 8 0 0 1 16 0" fill="url(#guidy-dawn)" />
      <rect x="3" y="20" width="26" height="2.4" rx="1.2" fill="url(#guidy-dawn)" />
      <circle cx="16" cy="20" r="2.6" fill="var(--site-surface, #fff)" />
      <circle cx="16" cy="20" r="1.5" fill="url(#guidy-dawn)" />
    </svg>
  );
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2 select-none">
      <LogoMark />
      {!compact && (
        <span className="font-display text-lg font-semibold tracking-tight text-site-ink">
          Guidy
        </span>
      )}
    </span>
  );
}