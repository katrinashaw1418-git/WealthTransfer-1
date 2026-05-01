interface ComplianceShellProps {
  children: React.ReactNode;
  showAiDisclaimer?: boolean;
  showRetentionStatement?: boolean;
  lastUpdated?: string;
}

export function ComplianceShell({
  children,
  showAiDisclaimer = false,
  showRetentionStatement = false,
  lastUpdated,
}: ComplianceShellProps) {
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
        AMAX Wealth Pty Ltd · Authorised Representative of [Licensee Name] · AFSL
        [000000] · AR [000000]
        {lastUpdated ? ` · Last updated: ${lastUpdated}` : ""}
      </div>

      {showAiDisclaimer && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
          AI-generated insights are general information only and do not constitute
          personal financial advice. Please speak with your adviser before making
          any financial decisions.
        </div>
      )}

      <div className="flex-1">{children}</div>

      <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
        <p>
          AMAX Wealth provides adviser-led financial product advice and reporting
          only. AMAX Wealth does not provide custody, remittance, exchange, or
          execution services.
        </p>
        {showRetentionStatement && (
          <p className="mt-1">
            Records are retained under Corporations Act record-keeping obligations,
            ASIC instruments, regulations, and AFSL conditions. Seven-year record
            retention applies to advice documents and supporting records.
          </p>
        )}
      </div>
    </div>
  );
}

