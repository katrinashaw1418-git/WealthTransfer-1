interface ComplianceShellProps {
  children: React.ReactNode;
  showAiDisclaimer?: boolean;
  showRetentionStatement?: boolean;
  lastUpdated?: string;
  /** Default preserves investor-facing wording. Use `"adviser"` inside AdviserLayout. */
  persona?: "client" | "adviser";
}

export function ComplianceShell({
  children,
  showAiDisclaimer = false,
  showRetentionStatement = false,
  lastUpdated,
  persona = "client",
}: ComplianceShellProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
        AMAX Wealth Pty Ltd
        {lastUpdated ? ` · Last updated: ${lastUpdated}` : ""}
      </div>

      {showAiDisclaimer && persona === "client" && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          AI-generated insights are general information only and do not constitute
          personal financial advice. Please speak with your adviser before making
          any financial decisions.
        </div>
      )}

      {showAiDisclaimer && persona === "adviser" && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          AI-generated drafts and suggestions are illustrative only. They do not replace
          your professional judgement, your licensee&apos;s policies, or a completed
          review before you issue any Statement of Advice or Record of Advice to a
          client.
        </div>
      )}

      <div className="flex-1">{children}</div>

      <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
        {persona === "client" ? (
          <p>
            AMAX Wealth provides reporting and portfolio information in support of your
            adviser. Nothing here is personal advice. AMAX Wealth does not provide custody,
            remittance, exchange, or execution services.
          </p>
        ) : (
          <p>
            This workspace supports financial planners preparing client materials and
            disclosure. Use outputs in line with your practice&apos;s policies. AMAX
            Wealth does not provide custody, remittance, exchange, or execution services
            through this portal.
          </p>
        )}
        {showRetentionStatement && (
          <p className="mt-1">
            Records are retained under Corporations Act record-keeping obligations,
            ASIC instruments, regulations, and applicable regulatory requirements.
            Seven-year record retention applies to advice documents and supporting
            records.
          </p>
        )}
      </div>
    </div>
  );
}

