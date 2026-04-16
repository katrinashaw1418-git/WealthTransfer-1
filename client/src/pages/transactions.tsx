import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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

export default function Transactions() {
  const [searchTerm, setSearchTerm] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
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
        <Button variant="outline" size="sm">
          <Download className="w-4 h-4 mr-2" />
          Export Statement
        </Button>
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

      <p className="text-center text-xs text-gray-400">
        All records are maintained for regulatory compliance and audit purposes.
      </p>
    </div>
  );
}
