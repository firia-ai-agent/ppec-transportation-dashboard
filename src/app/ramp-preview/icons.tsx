import { icon as iconMetrics } from "@/ui/tokens";

/**
 * Minimal inline icons for the ramp preview. Every state is icon + label, never colour alone
 * (DESIGN-DIRECTION §3). These are plain stand-ins drawn here so this page adds no dependency;
 * the shared shell replaces them with the Lucide names listed in §3. Their metrics come from
 * src/ui/tokens.ts so they match the §2 icon scale and stroke weight.
 */
type IconName = "check" | "alert" | "question" | "ban" | "offline" | "seat" | "wheelchair";

const PATHS: Record<IconName, React.ReactNode> = {
  check: <polyline points="20 6 9 17 4 12" />,
  alert: <>
    <path d="M12 3 22 20H2Z" />
    <line x1="12" y1="9" x2="12" y2="14" />
    <line x1="12" y1="17" x2="12" y2="17" />
  </>,
  question: <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.3 9.2a2.7 2.7 0 1 1 3.8 2.5c-.7.4-1.1 1-1.1 1.8" />
    <line x1="12" y1="17" x2="12" y2="17" />
  </>,
  ban: <>
    <circle cx="12" cy="12" r="9" />
    <line x1="5.6" y1="5.6" x2="18.4" y2="18.4" />
  </>,
  offline: <>
    <path d="M6 17a4 4 0 0 1 1-7.9 5 5 0 0 1 9.3 1.6A3.6 3.6 0 0 1 18 17Z" />
    <line x1="3" y1="3" x2="21" y2="21" />
  </>,
  seat: <>
    <path d="M7 4v8h8" />
    <path d="M7 16h11" />
    <line x1="18" y1="16" x2="18" y2="20" />
  </>,
  wheelchair: <>
    <circle cx="11" cy="4" r="2" />
    <path d="M11 8v6h5l3 6" />
    <circle cx="10" cy="16" r="5" />
  </>,
};

export function Icon({ name, size = iconMetrics.nav }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24"
      fill="none" stroke="currentColor" strokeWidth={iconMetrics.strokeWidth}
      strokeLinecap="round" strokeLinejoin="round"
      style={{ flex: "0 0 auto" }}
    >
      {PATHS[name]}
    </svg>
  );
}
