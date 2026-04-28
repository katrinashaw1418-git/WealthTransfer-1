// =============================================================================
// Task #297 — One-page Financial Claims Scheme explainer for advisers.
//
// Linked from the compliance disclaimer at the top of the adviser product
// shelf (`/adviser/products`). Plain-English summary aimed at advisers
// triaging client cash allocations — not a substitute for the relevant PDS
// or for the ADI's own disclosures.
// =============================================================================

import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, ShieldCheck, AlertCircle, ExternalLink } from "lucide-react";

import { FCS_CAP_PER_ADI_AUD } from "@shared/cash-deposit-protection";

const formatCap = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
  maximumFractionDigits: 0,
}).format(FCS_CAP_PER_ADI_AUD);

export default function AdviserFcsExplainer() {
  return (
    <div className="p-6 max-w-3xl space-y-6" data-testid="page-adviser-fcs-explainer">
      <div>
        <Link href="/adviser/products">
          <Button
            variant="ghost"
            size="sm"
            className="mb-2 -ml-2"
            data-testid="link-back-to-products"
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to product shelf
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-gray-900">
          Financial Claims Scheme (FCS) — adviser briefing
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          What the {formatCap} per-ADI cap actually covers, and what it does not.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            What the FCS protects
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-gray-700 space-y-3">
          <p>
            The Financial Claims Scheme is the Australian government guarantee
            that pays eligible deposit-holders if an Authorised Deposit-taking
            Institution (ADI) — a bank, building society, or credit union
            licensed by APRA — fails. It is administered by APRA and funded by
            an industry levy after a payout, so deposit-holders do not need to
            apply individually.
          </p>
          <p>
            Coverage applies to <span className="font-medium">deposit
            accounts</span> held by an account-holder at a single ADI, summed
            across savings, transaction, and term deposit balances at that
            ADI, up to{" "}
            <span className="font-semibold tabular-nums">{formatCap}</span>{" "}
            per account-holder per ADI.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertCircle className="h-4 w-4 text-amber-600" />
            What the FCS does <span className="italic">not</span> cover
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-gray-700 space-y-2">
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              <span className="font-medium">Money market funds</span>,
              registered managed funds, and any product whose structure label
              says <span className="italic">"Not an ADI deposit, not
              FCS-protected"</span>. These are investment products and carry
              issuer / market risk.
            </li>
            <li>
              Balances <span className="font-medium">above {formatCap}</span>{" "}
              per ADI per account-holder. The excess sits unprotected even if
              the rest of the balance is FCS-eligible.
            </li>
            <li>
              <span className="font-medium">Foreign-currency deposits</span>{" "}
              (FCS only covers AUD-denominated deposits with Australian ADIs).
            </li>
            <li>
              Investments such as shares, bonds, derivatives, crypto, and
              superannuation — even when held through a participating ADI's
              broker arm.
            </li>
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Implications for client allocations</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-gray-700 space-y-3">
          <p>
            When a client's cash holding at a single ADI passes {formatCap},
            the additional deposit is uncovered. Common ways to keep an
            allocation inside the cap:
          </p>
          <ul className="list-disc pl-5 space-y-1.5">
            <li>
              Split the balance across multiple ADIs (each one carries its
              own {formatCap} per-account-holder allowance).
            </li>
            <li>
              Use joint accounts deliberately — joint holders each get a
              separate {formatCap} cap on the same ADI.
            </li>
            <li>
              For larger treasury balances, blend FCS-protected deposits with
              non-FCS cash alternatives (e.g. money market funds) where the
              client has accepted the issuer / market risk in writing.
            </li>
          </ul>
          <p className="text-xs text-gray-500 pt-2">
            This briefing is general information only and is not personal
            advice. Always verify current ADI authorisation status and the
            terms of the specific deposit product on the ADI's PDS / TMD
            before recommending.
          </p>
        </CardContent>
      </Card>

      <div className="text-xs text-gray-500">
        Authoritative source:{" "}
        <a
          className="inline-flex items-center gap-1 text-blue-600 hover:underline"
          href="https://www.fcs.gov.au/"
          target="_blank"
          rel="noopener noreferrer"
          data-testid="link-fcs-gov-au"
        >
          fcs.gov.au
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    </div>
  );
}
