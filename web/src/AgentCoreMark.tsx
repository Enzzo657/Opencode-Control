type AgentCoreMarkProps = {
  className?: string;
  size?: number;
};

export function AgentCoreMark({ className = "", size = 24 }: AgentCoreMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={`agent-core-mark ${className}`}
      width={size}
      height={size}
      viewBox="0 0 38 38"
      fill="none"
    >
      <path
        d="M19.5 11V8M13 23L9 29.5M25 23L29 29.5"
        stroke="currentColor"
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <polygon points="19,11 26,15 26,23 19,27 12,23 12,15" fill="currentColor" />
      <circle cx="19.5" cy="4.5" r="3.5" fill="currentColor" />
      <circle cx="5.5" cy="30.5" r="3.5" fill="currentColor" />
      <circle cx="32.5" cy="30.5" r="3.5" fill="currentColor" />
    </svg>
  );
}
