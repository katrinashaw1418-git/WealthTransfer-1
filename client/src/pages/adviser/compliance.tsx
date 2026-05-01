import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PortalPageHeader } from "@/components/layout/PortalPageHeader";
import { StatusChip } from "@/components/ui/status-chip";

export default function AdviserCompliancePage() {
  return (
    <div className="space-y-6 p-6" data-testid="page-adviser-compliance">
      <PortalPageHeader
        eyebrow="Adviser portal"
        title="Compliance"
        description="Consent registers, fee rule monitoring, insurance records, AI audit artefacts, and retention posture."
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Card className="border-slate-200 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Fee consents active</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">10</p>
          </CardContent>
        </Card>
        <Card className="border-slate-200 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">FDS issued FY</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">10</p>
          </CardContent>
        </Card>
        <Card className="border-slate-200 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Expiring ≤30d</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-amber-700">2</p>
          </CardContent>
        </Card>
        <Card className="border-slate-200 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">LIF documentation</p>
            <p className="mt-1 text-2xl font-bold text-emerald-700">Current</p>
          </CardContent>
        </Card>
        <Card className="border-slate-200 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">7-year records</p>
            <p className="mt-1 text-2xl font-bold text-emerald-700">Retained</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="fee-consents" className="space-y-4">
        <TabsList className="grid h-auto w-full grid-cols-2 gap-1 md:grid-cols-3 lg:grid-cols-6">
          <TabsTrigger value="fee-consents">Fee consents & FDS</TabsTrigger>
          <TabsTrigger value="fee-rules">Fee rules</TabsTrigger>
          <TabsTrigger value="insurance">Insurance (LIF)</TabsTrigger>
          <TabsTrigger value="ai-audit">AI audit log</TabsTrigger>
          <TabsTrigger value="retention">Record retention</TabsTrigger>
          <TabsTrigger value="licence-scope">Licence scope</TabsTrigger>
        </TabsList>

        <TabsContent value="fee-consents">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <CardTitle className="text-base text-slate-900">Fee consent and disclosure controls</CardTitle>
              <StatusChip domain="feeConsent">Fee consent</StatusChip>
            </CardHeader>
            <CardContent className="space-y-4 text-sm leading-relaxed text-slate-600">
              <p>Monitor consent integrity, renewal windows, and FDS issuance for each retail client.</p>
              <div className="flex flex-wrap gap-2">
                <StatusChip domain="feeConsent" emphasis="solid">
                  Active
                </StatusChip>
                <StatusChip domain="feeConsent">Expiring</StatusChip>
                <StatusChip domain="feeConsent" className="border-red-200 bg-red-50 text-red-900">
                  Lapsed
                </StatusChip>
              </div>
              <Button size="sm" variant="outline" disabled>
                Deep links wire to your production compliance module
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="fee-rules">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-base text-slate-900">Fee rules</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm leading-relaxed text-slate-600">
              <p>Rule amounts, linked consent references, and integrity flags surface here for licensee review.</p>
              <p className="text-xs text-slate-500">
                Superseded rules remain read-only. Historical accruals stay visible in the client audit trail.
              </p>
              <Button size="sm" variant="outline" disabled>
                Connect fee engine when re-enabled
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="insurance">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base text-slate-900">Insurance (LIF)</CardTitle>
              <StatusChip domain="advice">Advice records</StatusChip>
            </CardHeader>
            <CardContent className="text-sm leading-relaxed text-slate-600">
              Life insurance reforms: replacement comparisons, commission disclosures, and supporting files for each
              replacement recommendation.
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="ai-audit">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base text-slate-900">AI audit log</CardTitle>
              <StatusChip domain="workflow">Model trace</StatusChip>
            </CardHeader>
            <CardContent className="text-sm leading-relaxed text-slate-600">
              Each draft stores prompts, model identifiers, and approval events. Issued advice remains the
              adviser-signed SOA or ROA.
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="retention">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-base text-slate-900">Record retention</CardTitle>
            </CardHeader>
            <CardContent className="text-sm leading-relaxed text-slate-600">
              Records are retained under Corporations Act obligations, ASIC instruments, regulations, and AFSL
              conditions. Advice files and supporting evidence follow your seven-year policy.
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="licence-scope">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader>
              <CardTitle className="text-base text-slate-900">Licence scope</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm leading-relaxed text-slate-600">
              <p>Authorised: managed investments, securities, superannuation, life insurance.</p>
              <p>Out-of-scope services remain documented only in controlled legal materials — not in client CTAs.</p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
