import { ChevronRight, FileSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScoreBadge } from "./score-badge";
import type { Lead, ScoreStatus } from "../_lib/types";
import { formatDate, formatDateTime, fullName } from "../_lib/utils";

interface LeadsTableProps {
  leads: Lead[];
  onSelectLead: (lead: Lead) => void;
}

const TAB_COLOR: Record<ScoreStatus, string> = {
  HOT: "#DC2626",
  WARM: "#D97706",
  COLD: "#94A3B8",
};

export function LeadsTable({ leads, onSelectLead }: LeadsTableProps) {
  if (leads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-white py-16 text-center">
        <FileSearch className="h-8 w-8 text-slate-300" aria-hidden="true" />
        <p className="text-sm font-medium text-slate-600">No leads match your filters</p>
        <p className="text-xs text-slate-400">Try a different search term or status.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <table className="w-full min-w-[720px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
            <th className="px-4 py-3 font-medium">Client</th>
            <th className="px-4 py-3 font-medium">Incident Date</th>
            <th className="px-4 py-3 font-medium">Score</th>
            <th className="px-4 py-3 font-medium">Practice Area</th>
            <th className="px-4 py-3 font-medium">Ingested</th>
            <th className="px-4 py-3 font-medium text-right">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {leads.map((lead) => (
            <tr
              key={lead.id}
              onClick={() => onSelectLead(lead)}
              className="cursor-pointer transition-colors hover:bg-slate-50"
            >
              <td
                className="border-l-[3px] px-4 py-3"
                style={{ borderLeftColor: TAB_COLOR[lead.scoreStatus] }}
              >
                <p className="font-medium text-[#16233F]">{fullName(lead)}</p>
                <p className="font-[family-name:var(--font-mono)] text-xs text-slate-400">
                  {lead.clientPhone}
                </p>
              </td>
              <td className="px-4 py-3 font-[family-name:var(--font-mono)] text-slate-600">
                {formatDate(lead.incidentDate)}
              </td>
              <td className="px-4 py-3">
                <ScoreBadge status={lead.scoreStatus} />
              </td>
              <td className="px-4 py-3 text-slate-600">{lead.practiceArea}</td>
              <td className="px-4 py-3 font-[family-name:var(--font-mono)] text-slate-500">
                {formatDateTime(lead.dateIngested)}
              </td>
              <td className="px-4 py-3 text-right">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[#16233F] hover:bg-[#16233F]/[0.06]"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectLead(lead);
                  }}
                >
                  Review
                  <ChevronRight className="ml-1 h-3.5 w-3.5" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
