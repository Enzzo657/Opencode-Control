type AgentCoreMarkProps = {
  className?: string;
  size?: number;
};

export function AgentCoreMark({ className = "", size = 32 }: AgentCoreMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={`agent-core-mark ${className}`}
      width={size}
      height={size}
      viewBox="5 0 90 90"
      fill="none"
    >
      <path
        d="M50 36V27M38 57L32 65M62 57L68 65"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polygon points="50,35 64,43 64,57 50,65 36,57 36,43" fill="currentColor" />
      <circle cx="50" cy="20" r="7" fill="currentColor" />
      <circle cx="25" cy="68" r="7" fill="currentColor" />
      <circle cx="75" cy="68" r="7" fill="currentColor" />
    </svg>
  );
}
