import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PortalPageHeader } from "@/components/layout/PortalPageHeader";
import { StatusChip } from "@/components/ui/status-chip";

type ReportTab = "all" | "soa" | "roa" | "fds" | "pds" | "annual-review" | "portfolio-reports";

interface DocRow {
  id: number;
  tab: Exclude<ReportTab, "all">;
  title: string;
  status: string;
  statusDomain: "report" | "advice" | "workflow";
  emphasis?: "solid";
}

const DOCUMENTS: DocRow[] = [
  {
    id: 1,
    tab: "soa",
    title: "SOA — Sarah Mitchell · Portfolio review",
    status: "Pending adviser approval",
    statusDomain: "advice",
  },
  {
    id: 2,
    tab: "fds",
    title: "FDS — Sarah Mitchell · FY2025-26",
    status: "Ready to send",
    statusDomain: "report",
    emphasis: "solid",
  },
  {
    id: 3,
    tab: "roa",
    title: "ROA — Priya Thomas · Subsequent advice",
    status: "Ready to send",
    statusDomain: "report",
    emphasis: "solid",
  },
  {
    id: 4,
    tab: "pds",
    title: "PDS — Sarah Mitchell · Delivered",
    status: "Acknowledged",
    statusDomain: "report",
    emphasis: "solid",
  },
  {
    id: 5,
    tab: "annual-review",
    title: "Annual review — James Whitfield",
    status: "Draft in progress",
    statusDomain: "workflow",
  },
  {
    id: 6,
    tab: "portfolio-reports",
    title: "Portfolio report — Q1 book roll-up",
    status: "Sent",
    statusDomain: "report",
  },
];

function DocStatusChip({ status, statusDomain, emphasis }: Pick<DocRow, "status" | "statusDomain" | "emphasis">) {
  return (
    <StatusChip domain={statusDomain} emphasis={emphasis}>
      {status}
    </StatusChip>
  );
}

function DocumentList({ tab }: { tab: ReportTab }) {
  const items = useMemo(
    () => (tab === "all" ? DOCUMENTS : DOCUMENTS.filter((d) => d.tab === tab)),
    [tab],
  );

  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
          No documents in this category for the sample book.
        </p>
      ) : (
        items.map((row) => (
          <div
            key={row.id}
            className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 md:flex-row md:items-center md:justify-between"
          >
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium text-slate-900">{row.title}</p>
              <p className="text-xs text-slate-500">
                Versioned file retained for seven-year record obligations.
              </p>
            </div>
            <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
              <DocStatusChip
                status={row.status}
                statusDomain={row.statusDomain}
                emphasis={row.emphasis}
              />
              <Button
                size="sm"
                variant="outline"
                disabled
                title="Document preview is not connected on this screen."
              >
                Preview — preview only
              </Button>
              <Button
                size="sm"
                disabled
                title="Document open / download is not connected on this screen."
              >
                Open — not connected
              </Button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

const TAB_VALUES: ReportTab[] = ["all", "soa", "roa", "fds", "pds", "annual-review", "portfolio-reports"];

export default function AdviserReportsV2() {
  return (
    <div className="space-y-8 p-6" data-testid="page-adviser-reports-v2">
      <PortalPageHeader
        eyebrow="Adviser portal"
        title="Reports"
        description="Advice documents, disclosure artefacts, and delivery status across your client book."
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          ["Ready to send", "3", "SOA + FDS"],
          ["Pending approval", "1", "SOA draft"],
          ["Sent this month", "6", "Delivered"],
          ["PDS on file", "8", "Retail book"],
        ].map(([label, value, helper]) => (
          <Card key={label} className="border-slate-200 shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-bold tabular-nums text-slate-900">{value}</p>
              <p className="mt-1 text-xs text-slate-500">{helper}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base text-slate-900">Document register</CardTitle>
          <StatusChip domain="report">Report / document</StatusChip>
        </CardHeader>
        <CardContent className="space-y-4">
          <Tabs defaultValue="all" className="w-full">
            <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-4 lg:grid-cols-7">
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="soa">SOA</TabsTrigger>
              <TabsTrigger value="roa">ROA</TabsTrigger>
              <TabsTrigger value="fds">FDS</TabsTrigger>
              <TabsTrigger value="pds">PDS</TabsTrigger>
              <TabsTrigger value="annual-review">Annual review</TabsTrigger>
              <TabsTrigger value="portfolio-reports">Portfolio reports</TabsTrigger>
            </TabsList>
            {TAB_VALUES.map((v) => (
              <TabsContent key={v} value={v} className="mt-4">
                <DocumentList tab={v} />
              </TabsContent>
            ))}
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
