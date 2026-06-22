"use client";

type ShapeAvatarProps = {
  seed: string;
  size?: number;
  className?: string;
};

function hashString(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return hash;
}

const PALETTE = [
  "#38bdf8",
  "#22d3ee",
  "#34d399",
  "#f59e0b",
  "#f97316",
  "#fb7185",
  "#a78bfa",
  "#60a5fa",
] as const;

export function ShapeAvatar({ seed, size = 40, className }: ShapeAvatarProps) {
  const hash = hashString(seed || "agent");
  const base = PALETTE[hash % PALETTE.length];
  const accent = PALETTE[(hash >> 3) % PALETTE.length];
  const shape = hash % 3;
  const face = (hash >> 5) % 4;

  const head = (() => {
    if (shape === 0) {
      return <circle cx="20" cy="15" r="7" fill={accent} opacity="0.95" />;
    }
    if (shape === 1) {
      return <rect x="13" y="8" width="14" height="14" rx="4" fill={accent} opacity="0.95" />;
    }
    return <polygon points="20,7 28,22 12,22" fill={accent} opacity="0.95" />;
  })();

  const eyes = (() => {
    if (face === 0) {
      return (
        <>
          <circle cx="17" cy="15" r="1.2" fill="#020617" />
          <circle cx="23" cy="15" r="1.2" fill="#020617" />
        </>
      );
    }
    if (face === 1) {
      return (
        <>
          <rect x="16" y="14.5" width="2.2" height="1.2" rx="0.6" fill="#020617" />
          <rect x="21.8" y="14.5" width="2.2" height="1.2" rx="0.6" fill="#020617" />
        </>
      );
    }
    if (face === 2) {
      return (
        <>
          <circle cx="16.6" cy="15.2" r="1" fill="#020617" />
          <circle cx="23.4" cy="15.2" r="1" fill="#020617" />
          <path d="M17 18.6 C18.4 19.8, 21.6 19.8, 23 18.6" stroke="#020617" strokeWidth="1" fill="none" />
        </>
      );
    }
    return (
      <>
        <path d="M15.5 15.3 L18 14.2" stroke="#020617" strokeWidth="1" />
        <path d="M24.5 15.3 L22 14.2" stroke="#020617" strokeWidth="1" />
      </>
    );
  })();

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={className}
      role="img"
      aria-label="Agent avatar"
    >
      <defs>
        <linearGradient id={`avatar-grad-${hash}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor={base} stopOpacity="0.85" />
          <stop offset="100%" stopColor="#0f172a" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="38" height="38" rx="12" fill={`url(#avatar-grad-${hash})`} stroke="rgba(148,163,184,0.4)" />
      {head}
      <rect x="12" y="24" width="16" height="10" rx="4" fill={accent} opacity="0.7" />
      {eyes}
    </svg>
  );
}
