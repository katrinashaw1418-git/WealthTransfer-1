import type { ReactNode } from "react";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { clientDisplayName } from "@shared/display-name";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PortalPageHeader } from "@/components/layout/PortalPageHeader";
import { StatusChip } from "@/components/ui/status-chip";
import { Skeleton } from "@/components/ui/skeleton";

interface AdviserClientEnforcementIndicators {
  adviceLifecycleLabel: string;
  feeConsentStandingLabel: string;
  executionReadinessLabel: string;
}

interface AdviserClientsListRow {
  userId: number;
  email: string;
  firstName: string;
  lastName: string;
  kycStatus: string;
  userTier: string;
  linkedAt: string | null;
  relationshipType: string;
  activeFeeConsents: number;
  feeConsentExpiringAt: string | null;
  portfolioValueAud: string;
  lastActivityAt: string | null;
  mostRecentExpiredConsentDate: string | null;
  enforcement: AdviserClientEnforcementIndicators;
}

interface AdviserClientsResponse {
  asOfDate: string;
  clients: AdviserClientsListRow[];
}

function formatPortfolioAud(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 0,
  }).format(n);
}

function lifecycleChipEmphasis(label: string): "default" | "solid" {
  if (
    label === "Advice accepted" ||
    label === "SOA viewed · awaiting acceptance"
  ) {
    return "solid";
  }
  return "default";
}

function enforcementFeeChipEmphasis(label: string): "default" | "solid" {
  if (label === "Valid") return "solid";
  return "default";
}

function EnforcementChips(indicators: AdviserClientEnforcementIndicators): ReactNode {
  const { adviceLifecycleLabel, feeConsentStandingLabel, executionReadinessLabel } =
    indicators;
  return (
    <>
      <StatusChip
        domain="advice"
        emphasis={lifecycleChipEmphasis(adviceLifecycleLabel)}
      >
        Advice: {adviceLifecycleLabel}
      </StatusChip>
      <StatusChip
        domain="feeConsent"
        emphasis={enforcementFeeChipEmphasis(feeConsentStandingLabel)}
      >
        Consent: {feeConsentStandingLabel}
      </StatusChip>
      <StatusChip
        domain={executionReadinessLabel === "Ready" ? "clientFactFind" : "workflow"}
        emphasis={executionReadinessLabel === "Ready" ? "solid" : "default"}
      >
        Execution: {executionReadinessLabel}
      </StatusChip>
    </>
  );
}

export default function AdviserClientsV2() {
  const { data, isLoading, isError, error } = useQuery<AdviserClientsResponse>({
    queryKey: ["/api/adviser/clients"],
  });

  const rows = data?.clients ?? [];

  const stats = useMemo(() => {
    const totalAum = rows.reduce((sum, r) => {
      const n = Number(r.portfolioValueAud);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
    const consentGaps = rows.filter(
      (r) =>
        r.enforcement.feeConsentStandingLabel === "Missing" ||
        r.enforcement.feeConsentStandingLabel === "Mismatched",
    ).length;
    return { totalAum, consentGaps, count: rows.length };
  }, [rows]);

  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) =>
        clientDisplayName(a, a.userId).localeCompare(
          clientDisplayName(b, b.userId),
          "en-AU",
        ),
      ),
    [rows],
  );

  return (
    <div className="space-y-8 p-6" data-testid="page-adviser-clients-v2">
      <PortalPageHeader
        eyebrow="Adviser portal"
        title="Clients"
        description="Your linked client book with read-only advice lifecycle, fee consent standing, and execution readiness from live server checks."
      />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="border-slate-200 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Total clients
            </p>
            {isLoading ? (
              <Skeleton className="mt-2 h-9 w-16" />
            ) : (
              <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
                {stats.count}
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="border-slate-200 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Assets under advice
            </p>
            {isLoading ? (
              <Skeleton className="mt-2 h-9 w-28" />
            ) : (
              <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
                {stats.totalAum <= 0
                  ? "—"
                  : new Intl.NumberFormat("en-AU", {
                      style: "currency",
                      currency: "AUD",
                      maximumFractionDigits: 0,
                    }).format(stats.totalAum)}
              </p>
            )}
          </CardContent>
        </Card>
        <Card className="border-slate-200 shadow-sm">
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Consent attention
            </p>
            {isLoading ? (
              <Skeleton className="mt-2 h-9 w-12" />
            ) : (
              <p className="mt-1 text-2xl font-bold tabular-nums text-amber-700">
                {stats.consentGaps}
              </p>
            )}
            <p className="mt-1 text-xs text-slate-500">
              Clients with Missing or Mismatched fee consent (server labels)
            </p>
          </CardContent>
        </Card>
      </div>

      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base text-slate-900">Client book</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {isError ? (
            <p className="text-sm text-red-700" role="alert">
              {error instanceof Error ? error.message : "Could not load clients."}
            </p>
          ) : null}
          {isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2].map((k) => (
                <Skeleton key={k} className="h-16 w-full rounded-lg" />
              ))}
            </div>
          ) : sortedRows.length === 0 ? (
            <p className="text-sm text-slate-600">No linked clients.</p>
          ) : (
            sortedRows.map((row) => (
              <div
                key={row.userId}
                className="flex flex-col gap-2 rounded-lg border border-slate-200 px-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">
                    {clientDisplayName(row, row.userId)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {formatPortfolioAud(row.portfolioValueAud)} under advice
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <EnforcementChips {...row.enforcement} />
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-base text-slate-900">About these indicators</CardTitle>
          <p className="text-sm text-slate-600">
            Advice lifecycle reflects the latest advice record for this adviser–client link. Fee
            consent uses your book-level active consent count together with whether a consent
            correctly supports that advice under the live execution check. Execution readiness is
            “Ready” only when the server&apos;s full execution gate passes for that latest advice;
            it is “Blocked” when there is no advice record yet or any gate fails. Labels are
            read-only.
          </p>
        </CardHeader>
      </Card>
    </div>
  );
}
