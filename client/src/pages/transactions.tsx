import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/auth";
import { useTransactions } from "@/hooks/use-portfolio";
import { Search, Download, ArrowUpRight, ArrowDownLeft, RefreshCw, FileText, Clock, CheckCircle2, XCircle, AlertCircle } from "lucide-react";

const getStatusIcon = (status: string) => {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    case "pending":
      return <Clock className="w-4 h-4 text-amber-500" />;
    case "failed":
      return <XCircle className="w-4 h-4 text-red-500" />;
    default:
      return <AlertCircle className="w-4 h-4 text-gray-400" />;
  }
};

const getTypeIcon = (type: string) => {
  switch (type) {
    case "deposit":
    case "crypto_buy":
      return <ArrowDownLeft className="w-4 h-4 text-green-600" />;
    case "withdrawal":
    case "crypto_sell":
      return <ArrowUpRight className="w-4 h-4 text-red-500" />;
    case "exchange":
    case "transfer":
      return <RefreshCw className="w-4 h-4 text-blue-500" />;
    default:
      return <FileText className="w-4 h-4 text-gray-400" />;
  }
};

const getTypeLabel = (type: string) => {
  const labels: Record<string, string> = {
    deposit: "Inflow",
    withdrawal: "Outflow",
    exchange: "Conversion",
    transfer: "Transfer",
    crypto_buy: "Acquisition",
    crypto_sell: "Disposal",
    adviser_fee_deduction: "Fee deduction",
    adviser_fee_deduction_reversal: "Fee reversal",
  };
  return labels[type] || type;
};

const formatAmount = (transaction: any) => {
  const amount = parseFloat(transaction.amount);
  if (transaction.type === "exchange") {
    const exchangeRate = parseFloat(transaction.exchangeRate);
    const convertedAmount = amount * exchangeRate;
    return `${amount.toLocaleString()} ${transaction.fromCurrency} → ${convertedAmount.toLocaleString()} ${transaction.toCurrency}`;
  }
  if (transaction.type === "deposit" || transaction.type === "crypto_buy") {
    return `+${amount.toLocaleString()} ${transaction.toCurrency}`;
  }
  if (transaction.type === "withdrawal" || transaction.type === "crypto_sell") {
    return `-${amount.toLocaleString()} ${transaction.fromCurrency}`;
  }
  return `${amount.toLocaleString()} ${transaction.fromCurrency || transaction.toCurrency}`;
};

// Task #338 — slug a username/email into something safe to drop straight
// into a Content-Disposition filename without surprising downstream tools.
// Falls back to "user" when the input is empty so the filename always
// matches the documented `account-activity_<user>_<from>_<to>.csv` shape.
function slugifyForFilename(value: string | null | undefined): string {
  if (!value) return "user";
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "user";
}

// Default the export window to the last 90 days. Long enough that the
// statement covers a quarter without manual fiddling, short enough that the
// download stays small for a typical client.
function defaultExportRange(): { from: string; to: string } {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 90);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { from: fmt(from), to: fmt(today) };
}

// Minimal, RFC-4180-ish CSV cell quoting. Wraps the cell in double-quotes
// when it contains a comma, quote, or newline; doubles embedded quotes.
function csvCell(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export default function Transactions() {
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [exportOpen, setExportOpen] = useState(false);
  const defaultRange = useMemo(defaultExportRange, []);
  const [exportFrom, setExportFrom] = useState<string>(defaultRange.from);
  const [exportTo, setExportTo] = useState<string>(defaultRange.to);
  const { user } = useAuth();
  const { toast } = useToast();
  const { data: transactions, isLoading, error } = useTransactions();

  const nonExchangeTransactions = transactions?.filter((t: any) => t.type !== "exchange") || [];
  const completedCount = nonExchangeTransactions.filter((t: any) => t.status === "completed").length;
  const pendingCount = nonExchangeTransactions.filter((t: any) => t.status === "pending").length;

  const filteredTransactions = transactions?.filter((transaction: any) => {
    if (transaction.type === "exchange") return false;
    const matchesSearch = transaction.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         transaction.fromCurrency?.toLowerCase().includes(searchTerm.toLowerCase()) ||
                         transaction.toCurrency?.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesType = typeFilter === "all" || transaction.type === typeFilter;
    const matchesStatus = statusFilter === "all" || transaction.status === statusFilter;
    return matchesSearch && matchesType && matchesStatus;
  });

  // Task #338 — generate the CSV from the same `transactions` query the page
  // is already showing (excluding exchanges, same as the on-screen list) and
  // scope it to the chosen [from, to] window. The window is inclusive: `to`
  // is bumped to end-of-day so a same-day pick still captures records made
  // earlier in the day. The filename includes the user identifier and the
  // ISO range so successive exports never collide on disk.
  const handleExport = () => {
    if (!exportFrom || !exportTo) {
      toast({
        title: "Pick a date range",
        description: "Both a from-date and a to-date are required.",
        variant: "destructive",
      });
      return;
    }
    const fromMs = new Date(`${exportFrom}T00:00:00`).getTime();
    const toMs = new Date(`${exportTo}T23:59:59.999`).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      toast({
        title: "Invalid date",
        description: "Could not parse the date range.",
        variant: "destructive",
      });
      return;
    }
    if (fromMs > toMs) {
      toast({
        title: "Invalid range",
        description: "The from-date must be on or before the to-date.",
        variant: "destructive",
      });
      return;
    }

    const rows = (transactions ?? []).filter((t: any) => {
      if (t.type === "exchange") return false;
      const ts = new Date(t.createdAt).getTime();
      return Number.isFinite(ts) && ts >= fromMs && ts <= toMs;
    });

    const header = [
      "Date",
      "Type",
      "Description",
      "From currency",
      "To currency",
      "Amount",
      "Fee",
      "Exchange rate",
      "Status",
    ];
    const lines = [header.map(csvCell).join(",")];
    for (const t of rows) {
      lines.push(
        [
          new Date(t.createdAt).toISOString(),
          getTypeLabel(t.type),
          t.description ?? "",
          t.fromCurrency ?? "",
          t.toCurrency ?? "",
          t.amount ?? "",
          t.fee ?? "",
          t.exchangeRate ?? "",
          t.status ?? "",
        ].map(csvCell).join(","),
      );
    }
    const csv = lines.join("\r\n") + "\r\n";

    const userSlug = slugifyForFilename(user?.username ?? user?.email ?? null);
    const filename = `account-activity_${userSlug}_${exportFrom}_${exportTo}.csv`;

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    setExportOpen(false);
    toast({
      title: "Statement downloaded",
      description: `${rows.length} record${rows.length === 1 ? "" : "s"} exported as ${filename}.`,
    });
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-3 gap-4">
          {[1, 2, 3].map(i => <Skeleton key={i} className="h-20" />)}
        </div>
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <div className="text-center py-12">
          <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-3" />
          <h2 className="text-lg font-semibold text-gray-900">Unable to load activity</h2>
          <p className="text-sm text-gray-500 mt-1">Please try again later</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Account Activity</h1>
          <p className="text-sm text-gray-500 mt-1">Record of all portfolio movements and transactions</p>
        </div>
        <Popover open={exportOpen} onOpenChange={setExportOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              data-testid="button-open-export"
            >
              <Download className="w-4 h-4 mr-2" />
              Export Statement
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-80" align="end">
            <div className="space-y-3">
              <div>
                <h4 className="text-sm font-semibold text-gray-900">
                  Export account activity
                </h4>
                <p className="text-xs text-gray-500 mt-0.5">
                  Pick the date range you want included in the CSV.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label htmlFor="export-from" className="text-xs">From</Label>
                  <Input
                    id="export-from"
                    type="date"
                    value={exportFrom}
                    max={exportTo || undefined}
                    onChange={(e) => setExportFrom(e.target.value)}
                    data-testid="input-export-from"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="export-to" className="text-xs">To</Label>
                  <Input
                    id="export-to"
                    type="date"
                    value={exportTo}
                    min={exportFrom || undefined}
                    onChange={(e) => setExportTo(e.target.value)}
                    data-testid="input-export-to"
                  />
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExportOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleExport}
                  data-testid="button-confirm-export"
                >
                  <Download className="w-3.5 h-3.5 mr-1.5" />
                  Download CSV
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2.5 bg-gray-100 rounded-lg">
              <FileText className="w-5 h-5 text-gray-600" />
            </div>
            <div>
              <p className="text-2xl font-bold">{nonExchangeTransactions.length}</p>
              <p className="text-xs text-gray-500">Total Records</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2.5 bg-green-50 rounded-lg">
              <CheckCircle2 className="w-5 h-5 text-green-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-green-700">{completedCount}</p>
              <p className="text-xs text-gray-500">Settled</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-4">
            <div className="p-2.5 bg-amber-50 rounded-lg">
              <Clock className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-amber-700">{pendingCount}</p>
              <p className="text-xs text-gray-500">Pending Settlement</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col md:flex-row md:items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
              <Input
                placeholder="Search activity..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex gap-2">
              <Select value={typeFilter} onValueChange={setTypeFilter}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Types</SelectItem>
                  <SelectItem value="deposit">Inflow</SelectItem>
                  <SelectItem value="withdrawal">Outflow</SelectItem>
                  <SelectItem value="transfer">Transfer</SelectItem>
                  <SelectItem value="crypto_buy">Acquisition</SelectItem>
                  <SelectItem value="crypto_sell">Disposal</SelectItem>
                  <SelectItem value="adviser_fee_deduction">Fee deduction</SelectItem>
                  <SelectItem value="adviser_fee_deduction_reversal">Fee reversal</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="All Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Status</SelectItem>
                  <SelectItem value="completed">Settled</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="divide-y">
            {filteredTransactions?.map((transaction: any) => (
              <div key={transaction.id} className="flex items-center gap-4 px-6 py-4 hover:bg-gray-50 transition-colors">
                <div className="p-2 bg-gray-100 rounded-lg flex-shrink-0">
                  {getTypeIcon(transaction.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-gray-900 truncate">{transaction.description}</p>
                    <Badge variant="outline" className="text-xs flex-shrink-0">
                      {getTypeLabel(transaction.type)}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs text-gray-400">
                      {new Date(transaction.createdAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}
                    </span>
                    <span className="text-xs text-gray-300">·</span>
                    <span className="text-xs text-gray-400">
                      {new Date(transaction.createdAt).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {transaction.exchangeRate && (
                      <>
                        <span className="text-xs text-gray-300">·</span>
                        <span className="text-xs text-gray-400">
                          Rate: {parseFloat(transaction.exchangeRate).toFixed(4)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className={`font-mono text-sm font-medium ${
                    transaction.type === 'deposit' || transaction.type === 'crypto_buy' 
                      ? 'text-green-700' 
                      : transaction.type === 'withdrawal' || transaction.type === 'crypto_sell'
                        ? 'text-red-600'
                        : 'text-gray-900'
                  }`}>
                    {formatAmount(transaction)}
                  </p>
                  {parseFloat(transaction.fee || '0') > 0 && (
                    <p className="text-xs text-gray-400 mt-0.5">
                      Fee: {parseFloat(transaction.fee).toFixed(2)} {transaction.fromCurrency || transaction.toCurrency}
                    </p>
                  )}
                </div>
                <div className="flex-shrink-0">
                  {getStatusIcon(transaction.status)}
                </div>
              </div>
            ))}
          </div>

          {filteredTransactions?.length === 0 && (
            <div className="text-center py-12">
              <FileText className="w-8 h-8 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No activity matching your filters</p>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="text-center text-xs text-gray-400 space-y-1">
        <p>All records are maintained in accordance with s912A of the Corporations Act 2001 (Cth) and retained for a minimum of 7 years.</p>
        <p>Transaction instructions are executed via external custodians and fund managers. AMAX Wealth does not hold client funds.</p>
      </div>
    </div>
  );
}
