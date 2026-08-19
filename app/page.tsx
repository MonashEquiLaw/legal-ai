"use client";

import { useMemo, useState } from "react";
import { IBM_Plex_Mono, Source_Serif_4 } from "next/font/google";
import { StatsHeader } from "./_components/stats-header";
import { LeadsToolbar } from "./_components/leads-toolbar";
import { LeadsTable } from "./_components/leads-table";
import { LeadDetailSheet } from "./_components/lead-detail-sheet";
import { MOCK_LEADS, MOCK_STATS } from "./_lib/mock-data";
import type { Lead, StatusFilter } from "./_lib/types";
import { fullName } from "./_lib/utils";

const fontDisplay = Source_Serif_4({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-display",
});

const fontMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export default function LeadsDashboardPage() {
  const [leads, setLeads] = useState<Lead[]>(MOCK_LEADS);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [isSheetOpen, setIsSheetOpen] = useState(false);

  const visibleLeads = useMemo(
    () => leads.filter((lead) => !lead.dismissed),
    [leads]
  );

  const filteredLeads = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();

    return visibleLeads.filter((lead) => {
      const matchesStatus = statusFilter === "ALL" || lead.scoreStatus === statusFilter;
      if (!matchesStatus) return false;

      if (!query) return true;
      const nameMatch = fullName(lead).toLowerCase().includes(query);
      const phoneMatch = lead.clientPhone.replace(/\D/g, "").includes(query.replace(/\D/g, ""));
      return nameMatch || phoneMatch;
    });
  }, [visibleLeads, searchQuery, statusFilter]);

  const selectedLead = useMemo(
    () => leads.find((lead) => lead.id === selectedLeadId) ?? null,
    [leads, selectedLeadId]
  );

  function handleSelectLead(lead: Lead) {
    setSelectedLeadId(lead.id);
    setIsSheetOpen(true);
  }

  async function handleSync(leadId: string): Promise<void> {
    // Simulated network call to the CRM sync endpoint.
    await new Promise((resolve) => setTimeout(resolve, 1400));
    setLeads((prev) =>
      prev.map((lead) => (lead.id === leadId ? { ...lead, syncedToClio: true } : lead))
    );
  }

  function handleDismiss(leadId: string) {
    setLeads((prev) =>
      prev.map((lead) => (lead.id === leadId ? { ...lead, dismissed: true } : lead))
    );
    setIsSheetOpen(false);
  }

  return (
    <div className={`${fontDisplay.variable} ${fontMono.variable} min-h-screen bg-[#F5F6F8] px-6 py-8 lg:px-10`}>
      <div className="mx-auto flex max-w-6xl flex-col gap-6">
        <header>
          <p className="text-xs font-medium uppercase tracking-wide text-[#A9812E]">
            Intake Docket
          </p>
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold text-[#16233F]">
            AI-Screened Leads
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            Review, filter, and act on inbound intake conversations screened by the AI intake
            coordinator.
          </p>
        </header>

        <StatsHeader stats={MOCK_STATS} />

        <div className="flex flex-col gap-4">
          <LeadsToolbar
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            resultCount={filteredLeads.length}
          />
          <LeadsTable leads={filteredLeads} onSelectLead={handleSelectLead} />
        </div>
      </div>

      <LeadDetailSheet
        lead={selectedLead}
        open={isSheetOpen}
        onOpenChange={setIsSheetOpen}
        onSync={handleSync}
        onDismiss={handleDismiss}
      />
    </div>
  );
}
