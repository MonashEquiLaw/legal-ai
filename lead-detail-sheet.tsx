"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  Loader2,
  Mail,
  Phone,
  ShieldCheck,
  Sparkles,
  User,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { ScoreBadge } from "./score-badge";
import type { Lead } from "../_lib/types";
import { formatDate, formatTime, formatPhone, fullName, initials } from "../_lib/utils";

interface LeadDetailSheetProps {
  lead: Lead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSync: (leadId: string) => Promise<void>;
  onDismiss: (leadId: string) => void;
}

interface ChecklistItem {
  label: string;
  value: string;
  ok: boolean;
}

export function LeadDetailSheet({ lead, open, onOpenChange, onSync, onDismiss }: LeadDetailSheetProps) {
  const [isSyncing, setIsSyncing] = useState(false);
  const [justSynced, setJustSynced] = useState(false);

  // Reset transient UI state whenever a different lead is opened.
  useEffect(() => {
    setIsSyncing(false);
    setJustSynced(false);
  }, [lead?.id]);

  if (!lead) return null;

  const isSynced = lead.syncedToClio || justSynced;

  const checklist: ChecklistItem[] = [
    { label: "Jurisdiction", value: lead.jurisdictionState, ok: true },
    { label: "Incident Date", value: formatDate(lead.incidentDate), ok: true },
    {
      label: "Medical Status",
      value: lead.injurySeverity === "NONE" ? "No injury reported" : lead.injurySeverity,
      ok: lead.injurySeverity !== "NONE",
    },
    { label: "SOL Status", value: lead.solStatus, ok: lead.solStatus !== "Expired" },
  ];

  async function handleSync() {
    setIsSyncing(true);
    try {
      await onSync(lead!.id);
      setJustSynced(true);
    } finally {
      setIsSyncing(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        {/* Header */}
        <SheetHeader className="space-y-0 border-b border-slate-200 px-6 py-5 text-left">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#16233F] font-[family-name:var(--font-display)] text-sm font-semibold text-white">
                {initials(lead)}
              </span>
              <div>
                <SheetTitle className="font-[family-name:var(--font-display)] text-xl text-[#16233F]">
                  {fullName(lead)}
                </SheetTitle>
                <SheetDescription asChild>
                  <div className="mt-1 flex flex-col gap-0.5 font-[family-name:var(--font-mono)] text-xs text-slate-500">
                    <span className="flex items-center gap-1.5">
                      <Phone className="h-3 w-3" /> {formatPhone(lead.clientPhone)}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <Mail className="h-3 w-3" /> {lead.clientEmail}
                    </span>
                  </div>
                </SheetDescription>
              </div>
            </div>
            <ScoreBadge status={lead.scoreStatus} confidence={lead.confidenceScore} />
          </div>
        </SheetHeader>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {/* Section 1: Executive Brief */}
          <section aria-labelledby="executive-brief-heading">
            <div className="mb-2 flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-[#A9812E]" />
              <h3
                id="executive-brief-heading"
                className="text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Executive Brief
              </h3>
            </div>
            <p className="rounded-md border border-slate-200 bg-slate-50 p-4 text-sm leading-relaxed text-slate-700">
              {lead.summaryOfFacts}
            </p>
          </section>

          <Separator className="my-5" />

          {/* Section 2: Structured Fact Extraction Checklist */}
          <section aria-labelledby="fact-checklist-heading">
            <h3
              id="fact-checklist-heading"
              className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              Fact Extraction
            </h3>
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {checklist.map((item) => (
                <div
                  key={item.label}
                  className="flex items-start gap-2 rounded-md border border-slate-200 p-3"
                >
                  {item.ok ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
                  )}
                  <div>
                    <dt className="text-xs text-slate-500">{item.label}</dt>
                    <dd className="text-sm font-medium text-[#16233F]">{item.value}</dd>
                  </div>
                </div>
              ))}
            </dl>
          </section>

          <Separator className="my-5" />

          {/* Section 3: Full Chat Transcript Timeline */}
          <section aria-labelledby="transcript-heading">
            <h3
              id="transcript-heading"
              className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500"
            >
              Chat Transcript
            </h3>
            <ol className="space-y-3">
              {lead.transcript.map((message) => {
                const isAi = message.speaker === "ai";
                return (
                  <li key={message.id} className={`flex gap-2.5 ${isAi ? "" : "flex-row-reverse text-right"}`}>
                    <span
                      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                        isAi ? "bg-[#16233F]/[0.08] text-[#16233F]" : "bg-[#A9812E]/[0.15] text-[#8A6A24]"
                      }`}
                    >
                      {isAi ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
                    </span>
                    <div className={`max-w-[80%] ${isAi ? "" : "flex flex-col items-end"}`}>
                      <div
                        className={`rounded-lg px-3 py-2 text-sm leading-snug ${
                          isAi
                            ? "bg-slate-100 text-slate-700"
                            : "bg-[#16233F] text-white"
                        }`}
                      >
                        {message.content}
                      </div>
                      <span className="mt-1 flex items-center gap-1 font-[family-name:var(--font-mono)] text-[11px] text-slate-400">
                        <Clock3 className="h-3 w-3" />
                        {formatTime(message.timestamp)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>

        {/* Action Footer */}
        <div className="flex flex-col gap-2 border-t border-slate-200 bg-white px-6 py-4 sm:flex-row-reverse">
          <Button
            onClick={handleSync}
            disabled={isSyncing || isSynced}
            className="bg-[#A9812E] text-white hover:bg-[#8A6A24] sm:flex-1"
          >
            {isSyncing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Syncing…
              </>
            ) : isSynced ? (
              <>
                <ShieldCheck className="mr-2 h-4 w-4" />
                Synced to Clio
              </>
            ) : (
              "Sync to Clio CRM"
            )}
          </Button>
          <Button
            variant="outline"
            onClick={() => onDismiss(lead.id)}
            className="border-slate-300 text-slate-600 hover:bg-slate-50 hover:text-slate-800 sm:flex-1"
          >
            Dismiss Lead
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
