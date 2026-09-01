export function RivjuLogo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      className={className}
      role="img"
      aria-label="rivju"
    >
      <defs>
        <linearGradient id="rivju-brand-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#4fb8b2" />
          <stop offset="0.55" stopColor="#328f97" />
          <stop offset="1" stopColor="#2f6a4a" />
        </linearGradient>
      </defs>
      <rect x="100" y="100" width="824" height="824" rx="184" fill="url(#rivju-brand-bg)" />
      <circle cx="384" cy="380" r="76" fill="#ffffff" />
      <circle cx="640" cy="380" r="76" fill="#ffffff" />
      <path
        d="M384 380h136q120 0 120 120v136"
        fill="none"
        stroke="#ffffff"
        strokeWidth="64"
        strokeLinecap="round"
      />
      <path d="M640 456v180" fill="none" stroke="#ffffff" strokeWidth="64" strokeLinecap="round" />
      <path d="M560 616l80 96 80-96z" fill="#ffffff" />
    </svg>
  )
}
