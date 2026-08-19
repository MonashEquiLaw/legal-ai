import { cn } from "@/lib/utils";
import type { ScoreStatus } from "../_lib/types";

interface ScoreBadgeProps {
  status: ScoreStatus;
  confidence?: number;
  className?: string;
}

const STATUS_STYLES: Record<ScoreStatus, string> = {
  HOT: "bg-red-50 text-red-700 ring-red-600/20",
  WARM: "bg-amber-50 text-amber-700 ring-amber-600/20",
  COLD: "bg-slate-100 text-slate-600 ring-slate-500/20",
};

const STATUS_DOT: Record<ScoreStatus, string> = {
  HOT: "bg-red-600",
  WARM: "bg-amber-500",
  COLD: "bg-slate-400",
};

export function ScoreBadge({ status, confidence, className }: ScoreBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ring-1 ring-inset",
        STATUS_STYLES[status],
        className
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[status])} aria-hidden="true" />
      {status}
      {typeof confidence === "number" && (
        <span className="font-[family-name:var(--font-mono)] font-normal normal-case text-[11px] opacity-70">
          {Math.round(confidence * 100)}%
        </span>
      )}
    </span>
  );
}
