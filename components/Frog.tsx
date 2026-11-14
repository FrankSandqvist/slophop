/** Thin-line mascot. Blinks now and then; hops on hover of its parent link. */
export function Frog({ size = 28 }: { size?: number }) {
  return (
    <svg className="frog" width={size} height={size} viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 22c0-6 5-10 11-10s11 4 11 10c0 3-4 5-11 5S5 25 5 22Z" />
      <circle cx="10.5" cy="11" r="3.6" fill="var(--sh-surface)" />
      <circle cx="21.5" cy="11" r="3.6" fill="var(--sh-surface)" />
      <g className="frog-pupils">
        <circle cx="11" cy="11.4" r="1.2" fill="currentColor" stroke="none" />
        <circle cx="22" cy="11.4" r="1.2" fill="currentColor" stroke="none" />
      </g>
      <path d="M12 20.5c2.4 1.6 5.6 1.6 8 0" />
      <path d="M6 26.5 3.5 29M26 26.5l2.5 2.5" />
    </svg>
  );
}
