import { useQuery } from "@tanstack/react-query";
import { useRoute, Link } from "wouter";
import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, ShieldCheck, ShieldAlert, FileText } from "lucide-react";

const TOKEN_KEY = "amax_jwt";

function authHeaders(): Record<string, string> {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
}

interface RequiredShape {
  table: string;
  requiredFields: string[];
  signatureField: string;
  allRequiredTrue: boolean;
}

interface GateBlocked {
  blocked: true;
  status: number;
  reason: string;
  error: string;
  adviceAcknowledgements: RequiredShape | null;
}

interface AdvicePayload {
  blocked: false;
  advice: Record<string, unknown> & {
    id: number;
    adviceType?: string;
    status?: string;
    objectivesSummary?: string | null;
    soaIssued?: boolean;
    soaIssuedAt?: string | null;
    createdAt?: string | null;
  };
  acknowledgement: { id: number; acknowledgedAt: string | null };
}

type AdviceResponse = GateBlocked | AdvicePayload;

// Friendly labels for the eleven required confirmation booleans returned by
// the gate. Keep this in sync with the requiredFields list returned by
// GET /api/client/advice/:id when reason='acknowledgement_missing'.
const FIELD_LABELS: Record<string, string> = {
  confirmPersonalDetails: "I have reviewed my personal details and they are accurate",
  confirmFinancialInfo: "I have reviewed my financial information and it is accurate",
  confirmObjectives: "I have reviewed and agree with the recorded objectives",
  confirmRiskProfile: "I understand and agree with my risk profile",
  confirmScopeUnderstood: "I understand the scope of advice provided",
  confirmSoaViewed: "I have viewed the Statement of Advice in full",
  confirmFeesUnderstood: "I understand the fees that apply",
  confirmFeesConsented: "I consent to the fees being deducted",
  confirmValuesMayFall: "I understand the value of investments may fall as well as rise",
  confirmReturnsNotGuaranteed: "I understand returns are not guaranteed",
  confirmFsgReceived: "I confirm I have received the Financial Services Guide",
};

function fetchAdviceWithGate(adviceRecordId: number): Promise<AdviceResponse> {
  // We can't use the default queryFn here because a 403 is a SUCCESSFUL gate
  // response — we need to read the structured body, not throw. apiFetch would
  // also throw, so we hand-roll the request and explicitly handle 403/404.
  return fetch(`/api/client/advice/${adviceRecordId}`, {
    headers: authHeaders(),
  }).then(async (res) => {
    if (res.status === 401) {
      try {
        localStorage.removeItem(TOKEN_KEY);
      } catch {
        // ignore
      }
      if (typeof window !== "undefined") {
        window.location.href = "/login";
      }
      throw new Error("401: token expired");
    }
    const body = await res.json().catch(() => ({}));
    if (res.status === 403 || res.status === 404) {
      return {
        blocked: true,
        status: res.status,
        reason: body?.reason ?? "unknown",
        error: body?.error ?? `${res.status}`,
        adviceAcknowledgements: body?.adviceAcknowledgements ?? null,
      } satisfies GateBlocked;
    }
    if (!res.ok) {
      throw new Error(body?.error ?? `${res.status}`);
    }
    return { blocked: false, ...body } as AdvicePayload;
  });
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString("en-AU", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function DisclaimerInterstitial({ data, adviceRecordId }: {
  data: GateBlocked;
  adviceRecordId: number;
}) {
  // Reason='advice_record_not_found' takes a different look — there is nothing
  // to acknowledge, the record simply doesn't exist (or doesn't belong to this
  // client). Render that case separately from the missing-ack flow.
  if (data.reason === "advice_record_not_found") {
    return (
      <Card>
        <CardContent className="pt-6 space-y-3">
          <div className="flex items-center gap-2 text-red-600">
            <ShieldAlert className="h-5 w-5" />
            <p className="text-sm font-semibold">Advice record not found</p>
          </div>
          <p className="text-sm text-gray-600">
            We couldn't find advice record #{adviceRecordId} for your account.
            If you believe this is an error, please contact your adviser.
          </p>
        </CardContent>
      </Card>
    );
  }

  const required = data.adviceAcknowledgements;
  return (
    <Card data-testid="disclaimer-interstitial">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2 text-amber-700">
          <ShieldAlert className="h-5 w-5" />
          Acknowledgement required before viewing advice
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-gray-700">
          Before we can show you the contents of advice record #{adviceRecordId},
          you must sign an acknowledgement covering the following items. Each
          item must be confirmed true and you must provide your full name as
          your signature. Your adviser will share the acknowledgement form with
          you.
        </p>
        {required ? (
          <div className="rounded-md border border-gray-200 p-4 bg-gray-50 space-y-3">
            <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
              Required confirmations
            </p>
            <ul
              className="space-y-1.5 text-sm text-gray-700"
              data-testid="list-required-fields"
            >
              {required.requiredFields.map((f) => (
                <li
                  key={f}
                  className="flex items-start gap-2"
                  data-testid={`required-${f}`}
                >
                  <span className="text-amber-500 mt-0.5">•</span>
                  <span>{FIELD_LABELS[f] ?? f}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-gray-500 pt-2 border-t border-gray-200">
              Plus your full name in the{" "}
              <code className="font-mono">{required.signatureField}</code>{" "}
              field as your signature. All confirmations must be ticked true.
            </p>
          </div>
        ) : null}
        <div className="rounded-md border border-sky-200 bg-sky-50 p-3 text-sm text-sky-800 flex items-start gap-2">
          <ShieldCheck className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>
            Please contact your adviser to receive and sign the acknowledgement.
            Once signed, refresh this page to view the advice.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ClientAdviceViewer() {
  const [, params] = useRoute<{ id: string }>("/client/advice/:id");
  const adviceRecordId = params?.id ? parseInt(params.id, 10) : NaN;
  const valid = Number.isFinite(adviceRecordId);

  // Refetch when the route id changes by including it in the queryKey.
  const advice = useQuery<AdviceResponse>({
    queryKey: ["/api/client/advice", adviceRecordId],
    enabled: valid,
    queryFn: () => fetchAdviceWithGate(adviceRecordId),
    // The gate is re-evaluated server-side on every request; cache once we
    // have the result for this record but stay quiet until the user reloads.
    retry: false,
  });

  // Document title — useful when the page is bookmarked.
  useEffect(() => {
    if (valid) document.title = `Advice #${adviceRecordId} · AMAX Wealth`;
  }, [valid, adviceRecordId]);

  if (!valid) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-red-600">Invalid advice record id.</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4" data-testid="page-client-advice-viewer">
      <div>
        <Link href="/client/wealth-planner">
          <Button variant="ghost" size="sm" data-testid="button-back-planner">
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to wealth planner
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 mt-2">
          Advice record #{adviceRecordId}
        </h1>
      </div>

      {advice.isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : advice.isError ? (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-red-600">
              Unable to load this advice record.
            </p>
          </CardContent>
        </Card>
      ) : advice.data?.blocked ? (
        <DisclaimerInterstitial
          data={advice.data}
          adviceRecordId={adviceRecordId}
        />
      ) : advice.data ? (
        <Card data-testid="card-advice-payload">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <FileText className="h-4 w-4 text-emerald-500" />
              {(advice.data.advice.adviceType ?? "advice").replace(/_/g, " ")}
              <Badge variant="outline" className="capitalize">
                {advice.data.advice.status ?? "unknown"}
              </Badge>
              {advice.data.advice.soaIssued ? (
                <Badge>SOA issued</Badge>
              ) : null}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 flex items-start gap-2">
              <ShieldCheck className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>
                You acknowledged this advice on{" "}
                {formatDate(advice.data.acknowledgement.acknowledgedAt)} (ack #
                {advice.data.acknowledgement.id}).
              </span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs uppercase text-gray-500">Created</div>
                <div>{formatDate(advice.data.advice.createdAt)}</div>
              </div>
              <div>
                <div className="text-xs uppercase text-gray-500">SOA issued</div>
                <div>
                  {advice.data.advice.soaIssued
                    ? formatDate(advice.data.advice.soaIssuedAt)
                    : "Not yet"}
                </div>
              </div>
            </div>
            {advice.data.advice.objectivesSummary ? (
              <div>
                <div className="text-xs uppercase text-gray-500 mb-1">
                  Objectives summary
                </div>
                <p className="whitespace-pre-wrap text-gray-700">
                  {advice.data.advice.objectivesSummary}
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
