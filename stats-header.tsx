import { Flame, Inbox, Timer, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DashboardStats } from "../_lib/types";
import { formatMinutes } from "../_lib/utils";

interface StatsHeaderProps {
  stats: DashboardStats;
}

interface StatCardConfig {
  label: string;
  value: string;
  icon: LucideIcon;
  accent: string;
}

export function StatsHeader({ stats }: StatsHeaderProps) {
  const cards: StatCardConfig[] = [
    {
      label: "Total Intakes",
      value: stats.totalIntakes.toLocaleString("en-US"),
      icon: Inbox,
      accent: "text-[#16233F] bg-[#16233F]/[0.06]",
    },
    {
      label: "Hot Leads (This Week)",
      value: stats.hotLeadsThisWeek.toLocaleString("en-US"),
      icon: Flame,
      accent: "text-red-600 bg-red-600/10",
    },
    {
      label: "Conversion Rate",
      value: `${stats.conversionRatePct.toFixed(1)}%`,
      icon: TrendingUp,
      accent: "text-[#8A6A24] bg-[#A9812E]/[0.12]",
    },
    {
      label: "Avg. Time to Review",
      value: formatMinutes(stats.avgTimeToReviewMinutes),
      icon: Timer,
      accent: "text-slate-600 bg-slate-500/10",
    },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <div
          key={card.label}
          className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              {card.label}
            </span>
            <span className={`flex h-8 w-8 items-center justify-center rounded-md ${card.accent}`}>
              <card.icon className="h-4 w-4" aria-hidden="true" />
            </span>
          </div>
          <p className="mt-3 font-[family-name:var(--font-display)] text-3xl font-semibold text-[#16233F]">
            {card.value}
          </p>
        </div>
      ))}
    </div>
  );
}
