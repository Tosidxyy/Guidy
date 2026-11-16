export function EmptyCalendar({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 320 180" fill="none" className={className ?? 'w-full max-w-[320px]'} aria-hidden="true">
      <defs>
        <linearGradient id="ec-dawn" x1="60" y1="150" x2="260" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFB86B" />
          <stop offset="0.5" stopColor="#FF7E5F" />
          <stop offset="1" stopColor="#6A5AE0" />
        </linearGradient>
        <linearGradient id="ec-sky" x1="160" y1="0" x2="160" y2="150" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFB86B" stopOpacity="0.16" />
          <stop offset="1" stopColor="#FFB86B" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="320" height="150" fill="url(#ec-sky)" />
      <path d="M100 150a60 60 0 0 1 120 0" fill="url(#ec-dawn)" opacity="0.9" />
      <path d="M0 150h320" stroke="var(--site-line)" strokeWidth="1.5" />
      <path d="M20 150C80 120 140 165 190 138S290 120 305 132" stroke="url(#ec-dawn)" strokeWidth="2" strokeDasharray="5 6" strokeLinecap="round" />
      <g opacity="0.85">
        <rect x="52" y="112" width="34" height="22" rx="5" fill="var(--site-cat-study)" fillOpacity="0.16" stroke="var(--site-cat-study)" strokeOpacity="0.5" />
        <rect x="52" y="112" width="3" height="22" rx="1.5" fill="var(--site-cat-study)" />
        <rect x="140" y="96" width="40" height="26" rx="5" fill="var(--site-cat-fitness)" fillOpacity="0.16" stroke="var(--site-cat-fitness)" strokeOpacity="0.5" />
        <rect x="140" y="96" width="3" height="26" rx="1.5" fill="var(--site-cat-fitness)" />
        <rect x="232" y="104" width="36" height="24" rx="5" fill="var(--site-cat-reading)" fillOpacity="0.16" stroke="var(--site-cat-reading)" strokeOpacity="0.5" />
        <rect x="232" y="104" width="3" height="24" rx="1.5" fill="var(--site-cat-reading)" />
      </g>
      <circle cx="160" cy="150" r="4" fill="url(#ec-dawn)" />
    </svg>
  );
}