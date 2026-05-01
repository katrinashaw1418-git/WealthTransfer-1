import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PortalPageHeader } from "@/components/layout/PortalPageHeader";
import { StatusChip } from "@/components/ui/status-chip";

export default function AdviserAiPlanningV2() {
  return (
    <div className="space-y-8 p-6" data-testid="page-adviser-ai-planning-v2">
      <PortalPageHeader
        eyebrow="Adviser portal"
        title="AI planning"
        description="Drafting workspace for model-generated recommendations. Final advice always sits in your SOA or ROA after review."
      />

      <div className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-950">
        <StatusChip domain="workflow">AI output</StatusChip>
        <p>
          Model output is supporting material only. It is not personal advice. This screen is a{" "}
          <span className="font-medium">read-only / draft layout preview</span> — nothing here saves, issues an SOA,
          or changes client or execution status.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="border-slate-200 shadow-sm lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="text-base text-slate-900">Draft recommendations</CardTitle>
            <StatusChip domain="workflow">Workflow status</StatusChip>
          </CardHeader>
          <CardContent className="space-y-3">
            {[["Sample planning draft (illustrative)", "Layout example"]].map(([title, status]) => (
              <div key={title} className="rounded-lg border border-slate-200 p-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-slate-900">{title}</p>
                  <StatusChip domain="workflow">{status}</StatusChip>
                </div>
                <p className="text-xs leading-relaxed text-slate-500">
                  Not linked to a live client or advice record. Your firm’s SOA / ROA process runs elsewhere.
                </p>
              </div>
            ))}
            <div className="space-y-2 border-t border-slate-100 pt-3">
              <p className="text-xs text-slate-600">
                Controls below are disabled — there is no backend action on this page yet.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled
                  title="Not connected to the server. Use your operational tools to persist edits."
                >
                  Save adviser edits — preview only
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled
                  title="Not connected to the server. No draft is rejected from this screen."
                >
                  Reject draft — preview only
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled
                  title="SOA preparation and issuance are not available on this screen. Use your firm’s operational advice workflow."
                >
                  Prepare SOA — not connected (preview)
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 shadow-sm">
          <CardHeader>
            <CardTitle className="text-base text-slate-900">Illustrative workflow labels</CardTitle>
            <p className="text-xs font-normal text-slate-500">
              Examples of stages your firm might use elsewhere. Not synced to advice lifecycle or enforcement.
            </p>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-slate-600">
            {[
              "Draft generated",
              "Adviser reviewing",
              "Ready for formal advice issuance (external)",
              "Rejected",
              "Superseded",
            ].map((s) => (
              <div key={s} className="flex items-center gap-2">
                <StatusChip domain="workflow">{s}</StatusChip>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
