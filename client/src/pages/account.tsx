import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Link, useLocation } from "wouter";
import { PortalPageHeader } from "@/components/layout/PortalPageHeader";
import { StatusChip } from "@/components/ui/status-chip";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ArrowRight } from "lucide-react";

/** Subset of GET /api/user safe payload used on this page. */
interface AccountUserWire {
  id?: number;
  username?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  kycStatus?: string | null;
  userTier?: string | null;
}

function hubButtonClass(path: string, location: string): string {
  const current = location === path;
  return cn(
    "border-slate-200",
    current && "border-sky-400 bg-sky-50 font-medium text-sky-950 shadow-sm hover:bg-sky-50",
  );
}

function formatKycLabel(raw: string | undefined): string {
  if (!raw) return "Pending";
  const t = raw.toLowerCase();
  if (t === "verified" || t === "approved") return "Verified";
  if (t === "pending" || t === "in_progress") return "In progress";
  if (t === "rejected" || t === "failed") return "Action required";
  return raw.replace(/_/g, " ");
}

function displayName(u: AccountUserWire): string {
  const parts = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  if (parts.length > 0) return parts;
  return u.username?.trim() || "—";
}

export default function AccountPage() {
  const [location] = useLocation();
  const account = useQuery<AccountUserWire>({
    queryKey: ["/api/user"],
    queryFn: () => api.getCurrentUser() as Promise<AccountUserWire>,
  });

  const isError = account.isError;
  const isLoading = account.isLoading;
  const u = account.data;
  const hasProfile = Boolean(u && typeof u.id === "number");
  const showEmptyProfile = !isLoading && !isError && !hasProfile;

  const isWholesale =
    u?.userTier === "hnwi" || u?.userTier === "professional" || u?.userTier === "wholesale";

  return (
    <div className="space-y-8 p-6" data-testid="page-account">
      <PortalPageHeader
        eyebrow="Investor portal"
        title="Account"
        description="Your profile, communication path to your advice practice, compliance status, and how AMAX Wealth supports your adviser relationship."
      />

      <nav className="flex flex-wrap gap-2" aria-label="Investor portal sections">
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/dashboard", location)}>
          <Link href="/dashboard">
            Dashboard <ArrowRight className="ml-1 h-3.5 w-3.5" />
          </Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/portfolio", location)}>
          <Link href="/portfolio">Portfolio</Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/ai-insights", location)}>
          <Link href="/ai-insights">AI insights</Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/goals", location)}>
          <Link href="/goals">Goals</Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/reports", location)}>
          <Link href="/reports">Reports</Link>
        </Button>
        <Button asChild size="sm" variant="outline" className={hubButtonClass("/account", location)}>
          <Link href="/account" aria-current={location === "/account" ? "page" : undefined}>
            Account
          </Link>
        </Button>
      </nav>

      <div
        className="flex flex-wrap items-start gap-3 rounded-lg border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-950"
        role="region"
        aria-label="Advice-only scope"
      >
        <StatusChip domain="advice">Account scope</StatusChip>
        <p className="min-w-0 flex-1 leading-relaxed">
          This area covers your profile, how to reach your practice, compliance status, and your
          relationship with your adviser through this platform. AMAX Wealth does not hold client assets,
          does not place orders, and does not move funds on your behalf. Product access and instructions
          are always adviser-led.
        </p>
      </div>

      <section className="space-y-4" aria-labelledby="profile-heading">
        <h2 id="profile-heading" className="text-sm font-semibold text-slate-900">
          Profile and compliance
        </h2>

        {isLoading ? (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Skeleton className="h-44 w-full rounded-lg" />
            <Skeleton className="h-44 w-full rounded-lg" />
          </div>
        ) : isError ? (
          <div className="rounded-lg border border-red-200 bg-red-50/80 px-4 py-6 text-center text-sm text-red-900">
            We couldn&apos;t load your account details. Refresh the page or sign in again if this continues.
          </div>
        ) : showEmptyProfile ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50/80 px-4 py-8 text-center text-sm text-slate-600">
            <p className="font-medium text-slate-800">No profile record returned</p>
            <p className="mt-2 max-w-md mx-auto leading-relaxed">
              Your session may still be starting. Try refreshing, or contact support if profile data never
              appears.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle className="text-base text-slate-900">Your details</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-slate-600">
                <p>
                  Name: <span className="font-medium text-slate-900">{u ? displayName(u) : "—"}</span>
                </p>
                <p>
                  Email: <span className="font-medium text-slate-900">{u?.email?.trim() || "—"}</span>
                </p>
                <p>
                  Username: <span className="font-medium text-slate-900">{u?.username?.trim() || "—"}</span>
                </p>
                <p className="text-xs leading-relaxed text-slate-500">
                  Use the same email for correspondence your adviser sends through this portal.
                </p>
              </CardContent>
            </Card>

            <Card className="border-slate-200 shadow-sm">
              <CardHeader>
                <CardTitle className="text-base text-slate-900">Client classification</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-3">
                <StatusChip domain="clientFactFind" emphasis="solid">
                  {isWholesale ? "Wholesale client" : "Retail client"}
                </StatusChip>
              </CardContent>
            </Card>

            <Card className="border-slate-200 shadow-sm lg:col-span-2">
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="text-base text-slate-900">Verification status</CardTitle>
                <StatusChip domain="clientFactFind">Compliance</StatusChip>
              </CardHeader>
              <CardContent className="space-y-2 text-sm text-slate-600">
                <p>
                  Identity status:{" "}
                  <span className="font-medium text-slate-900">
                    {formatKycLabel(u?.kycStatus ?? undefined)}
                  </span>
                </p>
                <p className="text-xs leading-relaxed text-slate-500">
                  Verification supports advice and compliance obligations. Your adviser can explain any
                  outstanding items.
                </p>
              </CardContent>
            </Card>
          </div>
        )}
      </section>

      <Card className="border-slate-200 shadow-sm">
        <CardHeader>
          <CardTitle className="text-base text-slate-900">Adviser relationship</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm leading-relaxed text-slate-600">
          <p>
            Your adviser manages your relationship and any formal disclosures. For questions about who
            provides services to you or official documents, contact your adviser or their practice
            directly.
          </p>
          <div className="flex flex-wrap gap-2">
            <StatusChip domain="advice">Financial product advice</StatusChip>
            <StatusChip domain="workflow">Adviser-led service</StatusChip>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
