import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PortalPageHeader } from "@/components/layout/PortalPageHeader";
import { StatusChip } from "@/components/ui/status-chip";

export default function AdviserDashboardV2() {
  return (
    <div className="space-y-8 p-6" data-testid="page-adviser-dashboard-v2">
      <PortalPageHeader
        eyebrow="Adviser portal"
        title="Dashboard"
        description="Book-level snapshot: open advice tasks, consent posture, and record-keeping health."
      />

      <div className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <StatusChip domain="feeConsent">Fee consent</StatusChip>
        <p>
          Two clients have fee consents expiring within 30 days. One SOA is pending your approval. Records are
          retained under Corporations Act obligations and AFSL conditions.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
        {[
          ["Total clients", "12", "8 retail · 4 wholesale"],
          ["Assets under advice", "$6.2M", "Reported book"],
          ["SOAs pending", "1", "Awaiting approval"],
          ["Fee consents expiring", "2", "Within 30 days"],
          ["Audit trail", "Current", "7-year retention"],
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

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="border-slate-200 shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base text-slate-900">Priority actions</CardTitle>
            <StatusChip domain="workflow">Workflow status</StatusChip>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-slate-700">
            {(
              [
                ["advice", "Advice", "SOA pending approval — Sarah Mitchell"],
                ["clientFactFind", "Client / fact-find", "Fact-find incomplete — Michael Roberts"],
                ["feeConsent", "Fee consent", "Consent expiring — Sandra Chen"],
                ["report", "Report / document", "Annual review due — James Whitfield"],
                ["report", "Report / document", "Three documents ready to send"],
              ] as const
            ).map(([domain, label, text]) => (
              <div key={text} className="flex flex-wrap items-start gap-2 rounded-md border border-slate-100 bg-slate-50/60 px-3 py-2">
                <StatusChip domain={domain}>{label}</StatusChip>
                <span>{text}</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base text-slate-900">Client book snapshot</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(
              [
                ["Sarah Mitchell", "$342,800", "SOA pending", "advice"],
                ["James Whitfield", "$487,240", "Active", "clientFactFind"],
                ["Michael Roberts", "$198,500", "Fact-find incomplete", "clientFactFind"],
                ["Priya Thomas", "$544,100", "Active", "clientFactFind"],
              ] as const
            ).map(([name, aum, status, domain]) => (
              <div
                key={name}
                className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 px-3 py-2.5 text-sm"
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">{name}</p>
                  <p className="text-xs text-slate-500">{aum}</p>
                </div>
                <StatusChip domain={domain}>{status}</StatusChip>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
