import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { PieChart as PieChartIcon } from "lucide-react";
import { useAiRecommendations } from "@/hooks/use-portfolio";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { apiRequest, apiFetch } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { 
  Bot, 
  Lightbulb, 
  TrendingUp, 
  AlertTriangle, 
  Target, 
  Shield, 
  BarChart3,
  Zap,
  CheckCircle,
  Clock,
  Eye,
  EyeOff,
  Phone,
  MessageCircle,
  X
} from "lucide-react";

function AdvisoryMetricUnavailable({
  title,
  description = "Not yet calculated from live portfolio history and current holdings.",
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
      <p className="text-sm font-medium text-amber-900">{title}</p>
      <p className="mt-1 text-sm text-amber-800">{description}</p>
    </div>
  );
}

// Category-specific colors consistent with Portfolio page
const getCategoryColor = (categoryName: string) => {
  const colorMap: { [key: string]: string } = {
    'Real Estate': '#FBBF24',     // Yellow
    'Corporate Credit': '#D1D5DB',  // Gray-300
    'Venture Capital': '#8B5CF6',  // Purple
    'Digital Assets': '#EF4444',   // Red
    'Cash Deposits': '#3B82F6'     // Blue
  };
  return colorMap[categoryName] || '#6B7280'; // Default gray
};

export default function AiAdvisory() {
  const [riskTolerance, setRiskTolerance] = useState([3]);
  const [investmentHorizon, setInvestmentHorizon] = useState("5-10");
  const [investmentGoal, setInvestmentGoal] = useState("growth");
  const [selectedRecommendation, setSelectedRecommendation] = useState<any>(null);
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);
  const [advisorModalOpen, setAdvisorModalOpen] = useState(false);
  const [advisorMessage, setAdvisorMessage] = useState('');
  const [showAdvisorBox, setShowAdvisorBox] = useState(true);
  const { data: recommendations, isLoading } = useAiRecommendations();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Fetch current portfolio allocation
  const { data: portfolioAllocation, isLoading: allocationLoading } = useQuery({
    queryKey: ["/api/portfolio/allocation"],
    queryFn: async () => (await apiFetch("/api/portfolio/allocation")).json(),
  });

  // Fetch investment breakdown
  const { data: investmentBreakdown, isLoading: breakdownLoading } = useQuery({
    queryKey: ["/api/investment-breakdown"],
    queryFn: async () => (await apiFetch("/api/investment-breakdown")).json(),
  });

  // Fetch portfolio data for performance calculations
  const { data: portfolio, isLoading: portfolioLoading } = useQuery({
    queryKey: ["/api/portfolio"],
    queryFn: async () => (await apiFetch("/api/portfolio")).json(),
  });

  // Fetch user investments for actual returns
  const { data: userInvestments, isLoading: investmentsLoading } = useQuery({
    queryKey: ["/api/user-investments"],
    queryFn: async () => (await apiFetch("/api/user-investments")).json(),
  });

  const { data: realMetrics, isLoading: metricsLoading } = useQuery({
    queryKey: ["/api/portfolio/real-metrics"],
    queryFn: async () => (await apiFetch("/api/portfolio/real-metrics")).json(),
  });

  const currentPortfolioAllocation = portfolioAllocation ? {
    fiat: portfolioAllocation.fiat.percentage,
    crypto: portfolioAllocation.crypto.percentage,
    stablecoin: portfolioAllocation.stablecoin.percentage,
    investment: portfolioAllocation.investment.percentage,
  } : {
    fiat: 0,
    crypto: 0,
    stablecoin: 0,
    investment: 0,
  };

  // Calculate performance data based on actual investment returns
  const totalPortfolioValue = portfolioAllocation?.totalValue || 0;
  const fiatValue = portfolioAllocation?.fiat?.value || 0;
  const cryptoValue = portfolioAllocation?.crypto?.value || 0;
  const stablecoinValue = portfolioAllocation?.stablecoin?.value || 0;
  const investmentValue = portfolioAllocation?.investment?.value || 0;

  // Calculate actual investment returns
  const totalInvested = userInvestments?.reduce((sum: number, inv: any) => sum + parseFloat(inv.investedAmount), 0) || 0;
  const totalCurrent = userInvestments?.reduce((sum: number, inv: any) => sum + parseFloat(inv.currentValue), 0) || 0;
  const investmentReturn = totalCurrent - totalInvested;
  const investmentReturnRate = totalInvested > 0 ? (investmentReturn / totalInvested) : 0;


  // Advisor contact mutation
  const advisorMutation = useMutation({
    mutationFn: async (data: { message: string }) => {
      const response = await apiRequest("POST", "/api/advisor/contact", data);
      if (!response.ok) {
        throw new Error('Failed to send message');
      }
      return response.json();
    },
    onSuccess: () => {
      toast({
        title: "Message Sent",
        description: "Your wealth planner will contact you within 24 hours.",
      });
      setAdvisorModalOpen(false);
      setAdvisorMessage('');
    },
    onError: () => {
      toast({
        title: "Message Failed",
        description: "Please try again later.",
        variant: "destructive",
      });
    }
  });

  // Generate new recommendations when risk profile changes
  const generateRecommendationsMutation = useMutation({
    mutationFn: async (profileData: { riskTolerance: number; investmentHorizon: string; investmentGoal: string }) => {
      const response = await apiRequest("POST", "/api/ai-recommendations/generate", profileData);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-recommendations"] });
      toast({
        title: "Recommendations Updated",
        description: "New AI recommendations generated based on your risk profile.",
      });
    },
  });

  // Update recommendations when risk profile changes
  const updateRecommendations = () => {
    generateRecommendationsMutation.mutate({
      riskTolerance: riskTolerance[0],
      investmentHorizon,
      investmentGoal,
    });
  };

  const markAsReadMutation = useMutation({
    mutationFn: (id: number) => api.markRecommendationAsRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-recommendations"] });
    },
  });

  const applyRecommendationMutation = useMutation({
    mutationFn: (id: number) => api.applyRecommendation(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-recommendations"] });
      toast({
        title: "Recommendation Applied",
        description: "The AI recommendation has been successfully implemented.",
      });
    },
    onError: () => {
      toast({
        title: "Application Failed",
        description: "Unable to apply the recommendation. Please try again.",
        variant: "destructive",
      });
    },
  });

  const getRecommendationIcon = (type: string) => {
    switch (type) {
      case "rebalancing":
        return Lightbulb;
      case "opportunity":
        return TrendingUp;
      case "risk_warning":
        return AlertTriangle;
      default:
        return Lightbulb;
    }
  };

  const getRecommendationColor = (severity: string) => {
    switch (severity) {
      case "info":
        return "bg-blue-50 border-blue-200";
      case "warning":
        return "bg-yellow-50 border-yellow-200";
      case "alert":
        return "bg-red-50 border-red-200";
      default:
        return "bg-blue-50 border-blue-200";
    }
  };

  const getIconColor = (severity: string) => {
    switch (severity) {
      case "info":
        return "text-blue-600";
      case "warning":
        return "text-yellow-600";
      case "alert":
        return "text-red-600";
      default:
        return "text-blue-600";
    }
  };

  const getTitleColor = (severity: string) => {
    switch (severity) {
      case "info":
        return "text-blue-900";
      case "warning":
        return "text-yellow-900";
      case "alert":
        return "text-red-900";
      default:
        return "text-blue-900";
    }
  };

  const getDescriptionColor = (severity: string) => {
    switch (severity) {
      case "info":
        return "text-blue-700";
      case "warning":
        return "text-yellow-700";
      case "alert":
        return "text-red-700";
      default:
        return "text-blue-700";
    }
  };

  // Dynamic portfolio suggestions based on risk profile, investment horizon, and goals
  const getSuggestedAllocation = () => {
    const risk = riskTolerance[0];
    let baseAllocation;
    
    // Base allocation by risk tolerance
    if (risk <= 2) { // Conservative
      baseAllocation = {
        usEquities: 20,
        intlEquities: 15,
        bonds: 50,
        crypto: 5,
        cash: 10,
      };
    } else if (risk <= 4) { // Moderate
      baseAllocation = {
        usEquities: 30,
        intlEquities: 25,
        bonds: 30,
        crypto: 10,
        cash: 5,
      };
    } else { // Aggressive
      baseAllocation = {
        usEquities: 40,
        intlEquities: 25,
        bonds: 15,
        crypto: 25,
        cash: 5,
      };
    }
    
    // Adjust based on investment horizon
    if (investmentHorizon === "1-3") { // Short term - more conservative
      baseAllocation.bonds += 10;
      baseAllocation.cash += 5;
      baseAllocation.crypto = Math.max(0, baseAllocation.crypto - 10);
      baseAllocation.usEquities = Math.max(0, baseAllocation.usEquities - 5);
    } else if (investmentHorizon === "10+") { // Long term - more aggressive
      baseAllocation.usEquities += 10;
      baseAllocation.crypto += 5;
      baseAllocation.bonds = Math.max(0, baseAllocation.bonds - 10);
      baseAllocation.cash = Math.max(0, baseAllocation.cash - 5);
    }
    
    // Adjust based on investment goal
    if (investmentGoal === "preservation") {
      baseAllocation.bonds += 15;
      baseAllocation.cash += 10;
      baseAllocation.crypto = Math.max(0, baseAllocation.crypto - 15);
      baseAllocation.usEquities = Math.max(0, baseAllocation.usEquities - 10);
    } else if (investmentGoal === "income") {
      baseAllocation.bonds += 10;
      baseAllocation.usEquities += 5; // Dividend stocks
      baseAllocation.crypto = Math.max(0, baseAllocation.crypto - 10);
      baseAllocation.cash = Math.max(0, baseAllocation.cash - 5);
    } else if (investmentGoal === "aggressive") {
      baseAllocation.crypto += 10;
      baseAllocation.usEquities += 10;
      baseAllocation.bonds = Math.max(0, baseAllocation.bonds - 15);
      baseAllocation.cash = Math.max(0, baseAllocation.cash - 5);
    }
    
    // Normalize to 100%
    const total = Object.values(baseAllocation).reduce((sum, val) => sum + val, 0);
    const normalizeFactor = 100 / total;
    
    return [
      { asset: "Fiat Assets", current: Math.round(currentPortfolioAllocation.fiat), suggested: Math.round(baseAllocation.usEquities * normalizeFactor), change: Math.round(baseAllocation.usEquities * normalizeFactor) - Math.round(currentPortfolioAllocation.fiat), color: "bg-blue-500" },
      { asset: "Crypto Assets", current: Math.round(currentPortfolioAllocation.crypto), suggested: Math.round(baseAllocation.crypto * normalizeFactor), change: Math.round(baseAllocation.crypto * normalizeFactor) - Math.round(currentPortfolioAllocation.crypto), color: "bg-red-500" },
      { asset: "Stablecoins", current: Math.round(currentPortfolioAllocation.stablecoin), suggested: Math.round(baseAllocation.intlEquities * normalizeFactor), change: Math.round(baseAllocation.intlEquities * normalizeFactor) - Math.round(currentPortfolioAllocation.stablecoin), color: "bg-gray-300" },
      { asset: "Investment Products", current: Math.round(currentPortfolioAllocation.investment), suggested: Math.round(baseAllocation.bonds * normalizeFactor), change: Math.round(baseAllocation.bonds * normalizeFactor) - Math.round(currentPortfolioAllocation.investment), color: "bg-purple-500" },
      { asset: "Cash Reserve", current: Math.round(baseAllocation.cash * normalizeFactor), suggested: Math.round(baseAllocation.cash * normalizeFactor), change: 0, color: "bg-gray-500" },
    ];
  };

  const suggestedAllocation = getSuggestedAllocation();

  const riskProfile = {
    score: riskTolerance[0] * 20,
    level: riskTolerance[0] <= 2 ? "Conservative" : riskTolerance[0] <= 4 ? "Moderate" : "Aggressive",
    description: (() => {
      const baseRisk = riskTolerance[0] <= 2 
        ? "You prefer stable returns with minimal risk of loss"
        : riskTolerance[0] <= 4 
        ? "You're comfortable with some volatility for potentially higher returns"
        : "You're willing to accept high volatility for maximum growth potential";
      
      const goalText = investmentGoal === "preservation" 
        ? ", focusing on capital preservation"
        : investmentGoal === "income" 
        ? ", prioritizing income generation"
        : investmentGoal === "growth" 
        ? ", targeting long-term growth"
        : ", pursuing aggressive growth";
      
      const horizonText = investmentHorizon === "1-3" 
        ? " over 1-3 years"
        : investmentHorizon === "3-5" 
        ? " over 3-5 years"
        : investmentHorizon === "5-10" 
        ? " over 5-10 years"
        : " over 10+ years";
      
      return baseRisk + goalText + horizonText + ".";
    })(),
  };

  if (isLoading || allocationLoading || breakdownLoading) {
    return (
      <div className="p-6 space-y-6">
        <div>
          <Skeleton className="h-8 w-48 mb-2" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-6 w-32 mb-4" />
                <Skeleton className="h-20 w-full" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Enhanced Header Section */}
      <div className="relative overflow-hidden">
        {/* Background Gradient */}
        <div className="absolute inset-0 bg-gradient-to-r from-blue-600 via-purple-600 to-indigo-600 opacity-10 rounded-2xl"></div>
        
        <div className="relative flex items-start justify-between p-8 bg-white/80 backdrop-blur-sm rounded-2xl border border-gray-200/50 shadow-lg">
          <div className="flex items-start space-x-4">
            {/* AI Icon */}
            <div className="w-16 h-16 bg-gradient-to-br from-blue-500 to-purple-600 rounded-2xl flex items-center justify-center shadow-lg">
              <Bot className="w-8 h-8 text-white" />
            </div>
            
            {/* Title and Description */}
            <div className="space-y-2">
              <div className="flex items-center space-x-3">
                <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
                  AI Advisory Dashboard
                </h1>
                <div className="flex items-center space-x-1 px-2 py-1 bg-green-100 rounded-full">
                  <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                  <span className="text-xs font-medium text-green-700">Active</span>
                </div>
              </div>
              
              <p className="text-gray-600 text-lg max-w-md">
                Get personalized investment insights and recommendations powered by artificial intelligence
              </p>
              
              <div className="flex items-center space-x-4 pt-2">
                <div className="flex items-center space-x-2 text-sm text-gray-500">
                  <Zap className="w-4 h-4" />
                  <span>Last updated: 2 minutes ago</span>
                </div>
                <div className="flex items-center space-x-2 text-sm text-gray-500">
                  <Shield className="w-4 h-4" />
                  <span>Secure & Private</span>
                </div>
              </div>
            </div>
          </div>
          

        </div>
      </div>

      {/* Floating Contact Your Advisor Box */}
      {showAdvisorBox && (
        <div className="fixed top-4 right-4 z-50">
          <Card className="w-72 shadow-2xl border-0 bg-white/95 backdrop-blur-lg">
            <CardHeader className="pb-3 relative">
              <CardTitle className="text-lg">
                Contact Your Advisor
              </CardTitle>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowAdvisorBox(false)}
                className="absolute top-2 right-2 h-6 w-6 p-0 hover:bg-gray-100"
              >
                <X className="w-4 h-4" />
              </Button>
            </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="bg-gradient-to-r from-blue-50 to-indigo-50 p-3 rounded-lg border border-blue-100">
                <div className="flex items-center space-x-3">
                  <div className="w-10 h-10 bg-gradient-to-r from-blue-500 to-indigo-600 rounded-full flex items-center justify-center">
                    <Phone className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <p className="text-xs text-blue-600 font-medium">+2 8320 1908</p>
                  </div>
                </div>
              </div>
              
              <div className="flex space-x-2">
                <Button 
                  variant="outline" 
                  size="sm"
                  onClick={() => window.open('tel:+283201908')}
                  className="flex-1 text-xs hover:bg-blue-50 border-blue-200"
                >
                  <Phone className="w-3 h-3 mr-1" />
                  Call
                </Button>
                <Button 
                  size="sm"
                  onClick={() => setAdvisorModalOpen(true)}
                  className="flex-1 text-xs bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700"
                >
                  <MessageCircle className="w-3 h-3 mr-1" />
                  Message
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
        </div>
      )}

      {/* AI Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-gray-500">Risk Score</h3>
              <Shield className="w-4 h-4 text-primary" />
            </div>
            <p className="text-2xl font-bold">{riskProfile.score}/100</p>
            <p className="text-sm text-gray-600 mt-1">{riskProfile.level}</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-gray-500">Active Recommendations</h3>
              <Lightbulb className="w-4 h-4 text-yellow-500" />
            </div>
            <p className="text-2xl font-bold">{recommendations?.length || 0}</p>
            <p className="text-sm text-gray-600 mt-1">New insights</p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-gray-500">Portfolio Health</h3>
              <BarChart3 className="w-4 h-4 text-secondary" />
            </div>
            {metricsLoading ? (
              <p className="text-2xl font-bold text-gray-300">—</p>
            ) : realMetrics ? (
              <>
                <p className="text-2xl font-bold text-secondary">
                  {realMetrics.diversificationScore.toFixed(0)}<span className="text-sm font-normal text-gray-500"> / 100</span>
                </p>
                <p className="text-sm text-gray-600 mt-1">Diversification score (HHI-based)</p>
              </>
            ) : (
              <p className="text-sm text-gray-400">Unavailable</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-gray-500">Realized CAGR</h3>
              <Zap className="w-4 h-4 text-purple-500" />
            </div>
            {metricsLoading ? (
              <p className="text-2xl font-bold text-gray-300">—</p>
            ) : realMetrics?.cagr != null ? (
              <>
                <p className={`text-2xl font-bold ${realMetrics.cagr >= 0 ? 'text-purple-600' : 'text-red-600'}`}>
                  {realMetrics.cagr >= 0 ? '+' : ''}{realMetrics.cagr.toFixed(1)}%
                </p>
                <p className="text-sm text-gray-600 mt-1">Annualized return from actual transaction history</p>
              </>
            ) : (
              <>
                <p className="text-2xl font-bold text-gray-400">—</p>
                <p className="text-sm text-gray-400 mt-1">Insufficient history to compute</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Risk Profile Configuration */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Risk Profile</CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div>
                <Label className="text-sm font-medium">Risk Tolerance</Label>
                <div className="mt-2">
                  <Slider
                    value={riskTolerance}
                    onValueChange={setRiskTolerance}
                    max={5}
                    min={1}
                    step={1}
                    className="w-full"
                  />
                  <div className="flex justify-between text-xs text-gray-500 mt-1">
                    <span>Conservative</span>
                    <span>Aggressive</span>
                  </div>
                </div>
              </div>

              <div>
                <Label htmlFor="investment-horizon">Investment Horizon</Label>
                <Select value={investmentHorizon} onValueChange={setInvestmentHorizon}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1-2">1-2 years</SelectItem>
                    <SelectItem value="3-5">3-5 years</SelectItem>
                    <SelectItem value="5-10">5-10 years</SelectItem>
                    <SelectItem value="10+">10+ years</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label htmlFor="investment-goal">Primary Goal</Label>
                <Select value={investmentGoal} onValueChange={setInvestmentGoal}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="preservation">Capital Preservation</SelectItem>
                    <SelectItem value="income">Income Generation</SelectItem>
                    <SelectItem value="growth">Growth</SelectItem>
                    <SelectItem value="aggressive">Aggressive Growth</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="p-4 bg-gray-50 rounded-lg">
                <h4 className="font-medium text-gray-900 mb-2">Your Profile</h4>
                <p className="text-sm text-gray-600">{riskProfile.description}</p>
              </div>

              <Button 
                onClick={updateRecommendations}
                disabled={generateRecommendationsMutation.isPending}
                className="w-full"
              >
                <Bot className="w-4 h-4 mr-2" />
                {generateRecommendationsMutation.isPending ? "Updating..." : "Update AI Recommendations"}
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* AI Recommendations */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>AI Recommendations</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {recommendations?.map((recommendation: any) => {
                  const Icon = getRecommendationIcon(recommendation.type);
                  
                  return (
                    <div
                      key={recommendation.id}
                      className={`p-4 rounded-lg border ${getRecommendationColor(recommendation.severity)}`}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-start space-x-3 flex-1">
                          <Icon className={`w-5 h-5 mt-0.5 ${getIconColor(recommendation.severity)}`} />
                          <div className="flex-1">
                            <div className="flex items-center justify-between mb-2">
                              <h4 className={`font-medium ${getTitleColor(recommendation.severity)}`}>
                                {recommendation.title}
                              </h4>
                              <div className="flex items-center space-x-2">
                                {!recommendation.isRead && (
                                  <Badge variant="secondary" className="text-xs">New</Badge>
                                )}
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => markAsReadMutation.mutate(recommendation.id)}
                                >
                                  {recommendation.isRead ? (
                                    <EyeOff className="w-3 h-3" />
                                  ) : (
                                    <Eye className="w-3 h-3" />
                                  )}
                                </Button>
                              </div>
                            </div>
                            <p className={`text-sm ${getDescriptionColor(recommendation.severity)} mb-3`}>
                              {recommendation.description}
                            </p>
                            <div className="flex space-x-2">
                              <Button 
                                size="sm" 
                                variant="outline"
                                onClick={() => {
                                  setSelectedRecommendation(recommendation);
                                  setDetailsModalOpen(true);
                                }}
                              >
                                View Details
                              </Button>
                              <Button 
                                size="sm" 
                                variant="outline"
                                onClick={() => applyRecommendationMutation.mutate(recommendation.id)}
                                disabled={applyRecommendationMutation.isPending}
                              >
                                {applyRecommendationMutation.isPending ? "Applying..." : "Apply Suggestion"}
                              </Button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Suggested Portfolio Allocation */}
          <Card>
            <CardHeader>
              <CardTitle>Suggested Portfolio Rebalancing</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {suggestedAllocation.map((allocation) => (
                  <div key={allocation.asset} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div className={`w-3 h-3 rounded-full ${allocation.color}`}></div>
                        <span className="font-medium">{allocation.asset}</span>
                      </div>
                      <div className="flex items-center space-x-4 text-sm">
                        <span className="text-gray-600">{allocation.current}%</span>
                        <span className="text-gray-400">→</span>
                        <span className="font-medium">{allocation.suggested}%</span>
                        <Badge 
                          variant={allocation.change > 0 ? "default" : allocation.change < 0 ? "destructive" : "secondary"}
                          className="text-xs"
                        >
                          {allocation.change > 0 ? '+' : ''}{allocation.change}%
                        </Badge>
                      </div>
                    </div>
                    <div className="flex space-x-2">
                      <Progress value={allocation.current} className="flex-1 h-2" />
                      <Progress value={allocation.suggested} className="flex-1 h-2" />
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-6 p-4 bg-blue-50 rounded-lg">
                <div className="flex items-start space-x-3">
                  <Target className="w-5 h-5 text-blue-600 mt-0.5 shrink-0" />
                  <div>
                    <h4 className="font-medium text-blue-900 mb-1">Rebalancing Gap</h4>
                    {metricsLoading ? (
                      <p className="text-sm text-blue-700">Loading…</p>
                    ) : realMetrics ? (
                      <>
                        <p className="text-2xl font-bold text-blue-800 mb-1">
                          {realMetrics.rebalancingGap.toFixed(1)}%
                        </p>
                        <p className="text-sm text-blue-700">
                          One-sided turnover needed to reach an equal-weight benchmark across the four asset classes.
                          {realMetrics.rebalancingGap < 10
                            ? ' Portfolio is well-balanced.'
                            : realMetrics.rebalancingGap < 25
                            ? ' Minor rebalancing recommended.'
                            : ' Significant rebalancing may be warranted.'}
                        </p>
                      </>
                    ) : (
                      <p className="text-sm text-blue-700">Unavailable</p>
                    )}
                  </div>
                </div>
              </div>
              <Button 
                className="w-full mt-4"
                onClick={() => {
                  // Create a rebalancing recommendation and apply it
                  const rebalancingRecommendation = {
                    id: Date.now(), // temporary ID
                    type: "rebalancing",
                    title: "Portfolio Rebalancing Strategy",
                    description: "Implement the suggested asset allocation to optimize risk-adjusted returns",
                    severity: "info" as const
                  };
                  applyRecommendationMutation.mutate(rebalancingRecommendation.id);
                }}
                disabled={applyRecommendationMutation.isPending}
              >
                {applyRecommendationMutation.isPending ? "Implementing..." : "Implement Rebalancing Strategy"}
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Performance and Risk Metrics */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Performance by Period — from snapshot history */}
        <Card>
          <CardHeader>
            <CardTitle>Performance by Period</CardTitle>
          </CardHeader>
          <CardContent>
            {metricsLoading ? (
              <div className="grid grid-cols-3 gap-3">
                {['YTD', '1M', '3M'].map(l => (
                  <div key={l} className="text-center p-3 bg-gray-50 rounded-lg">
                    <p className="text-xs text-gray-500 mb-1">{l}</p>
                    <p className="text-sm font-bold text-gray-300">—</p>
                  </div>
                ))}
              </div>
            ) : realMetrics?.hasSufficientHistory ? (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'YTD',  value: realMetrics.periodReturns.ytd },
                    { label: '1M',   value: realMetrics.periodReturns.oneMonth },
                    { label: '3M',   value: realMetrics.periodReturns.threeMonth },
                  ].map(({ label, value }) => (
                    <div key={label} className="text-center p-3 bg-gray-50 rounded-lg">
                      <p className="text-xs text-gray-600 mb-1">{label}</p>
                      {value !== null ? (
                        <p className={`text-sm font-bold ${value >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {value >= 0 ? '+' : ''}{value.toFixed(2)}%
                        </p>
                      ) : (
                        <p className="text-sm text-gray-400">N/A</p>
                      )}
                    </div>
                  ))}
                </div>
                {realMetrics.historySource === 'historical_estimate' && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                    Returns based on estimated historical snapshots. Estimated history is clearly labeled where used.
                  </p>
                )}
              </div>
            ) : (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
                <p className="text-sm font-medium text-amber-900">Insufficient snapshot history</p>
                <p className="mt-1 text-sm text-amber-800">
                  At least two portfolio snapshots are needed to compute period returns.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Risk Metrics */}
        <Card>
          <CardHeader>
            <CardTitle>Risk Metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <p className="text-xs text-gray-600 mb-1">YTD Return</p>
                  {metricsLoading ? (
                    <p className="text-sm font-bold text-gray-300">—</p>
                  ) : realMetrics?.periodReturns?.ytd !== null && realMetrics !== undefined ? (
                    <p className={`text-sm font-bold ${realMetrics.periodReturns.ytd! >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {realMetrics.periodReturns.ytd! >= 0 ? '+' : ''}{realMetrics.periodReturns.ytd!.toFixed(2)}%
                    </p>
                  ) : (
                    <p className="text-sm text-gray-400">—</p>
                  )}
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <p className="text-xs text-gray-600 mb-1">Annualised (CAGR)</p>
                  {metricsLoading ? (
                    <p className="text-sm font-bold text-gray-300">—</p>
                  ) : realMetrics?.cagr !== null && realMetrics !== undefined ? (
                    <p className={`text-sm font-bold ${realMetrics.cagr! >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {realMetrics.cagr! >= 0 ? '+' : ''}{realMetrics.cagr!.toFixed(2)}%
                    </p>
                  ) : (
                    <p className="text-sm text-gray-400">—</p>
                  )}
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <p className="text-xs text-gray-600 mb-1">Data Quality</p>
                  <p className="text-sm font-bold text-gray-700 capitalize">
                    {metricsLoading ? '—' : realMetrics?.riskMetricsState ?? 'limited'}
                  </p>
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <p className="text-xs text-gray-600 mb-1">Risk-Free Rate</p>
                  <p className="text-sm font-bold text-gray-700">
                    {metricsLoading ? '—' : `${realMetrics?.riskFreeRate ?? 4.00}%`}
                  </p>
                </div>
              </div>
              {realMetrics?.canComputeRiskMetrics && (
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: 'Sharpe Ratio',   value: realMetrics.sharpe,               unit: '' },
                    { label: 'Volatility p.a.', value: realMetrics.annualizedVolatility, unit: '%' },
                    { label: 'Max Drawdown',    value: realMetrics.maxDrawdown,          unit: '%' },
                  ].map(({ label, value, unit }) => (
                    <div key={label} className="text-center p-3 bg-gray-50 rounded-lg">
                      <p className="text-xs text-gray-600 mb-1">{label}</p>
                      {value !== null && value !== undefined ? (
                        <p className="text-sm font-bold text-gray-800">{value}{unit}</p>
                      ) : (
                        <p className="text-sm text-gray-400">—</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {!metricsLoading && (() => {
                const state = realMetrics?.riskMetricsState;
                if (state === 'limited') return (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <p className="text-xs font-medium text-amber-900">Building performance history</p>
                    <p className="text-xs text-amber-800 mt-1">
                      Risk metrics will appear once sufficient portfolio history and variability are observed.
                    </p>
                  </div>
                );
                if (state === 'estimated') return (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                    <p className="text-xs font-medium text-amber-900">Building performance history</p>
                    <p className="text-xs text-amber-800 mt-1">
                      Metrics will appear as more real portfolio data is recorded. Current values are based on reconstructed history.
                    </p>
                  </div>
                );
                return (
                  <div className="rounded-lg border border-green-200 bg-green-50 p-3">
                    <p className="text-xs font-medium text-green-900">Historical data</p>
                    <p className="text-xs text-green-800 mt-1">
                      Metrics are based on observed portfolio performance.
                    </p>
                  </div>
                );
              })()}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Investment Products Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <PieChartIcon className="h-5 w-5" />
            Investment Products
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center space-x-6">
            <div className="h-64 w-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={investmentBreakdown?.categories || []}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {(investmentBreakdown?.categories || []).map((entry: any, index: number) => (
                      <Cell key={`cell-${index}`} fill={getCategoryColor(entry.name)} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(value: number) => [`$${value.toLocaleString()}`, 'Value']} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex-1 space-y-3">
              {(investmentBreakdown?.categories || []).map((item: any, index: number) => (
                <div 
                  key={item.name} 
                  className="flex items-center justify-between hover:bg-gray-50 p-2 rounded-lg cursor-pointer transition-colors"
                  onClick={() => window.location.href = '/investments'}
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: getCategoryColor(item.name) }}></div>
                    <span className="font-medium">{item.name}</span>
                    <Badge variant="outline">{item.products.length} products</Badge>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold">{item.percentage.toFixed(1)}%</p>
                    <p className="text-sm text-gray-600">${item.value.toLocaleString()}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          {/* Individual Products */}
          <div className="mt-6 space-y-4">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-lg mb-3">Individual Investment Products</h4>
              <Button 
                variant="outline" 
                size="sm"
                onClick={() => window.location.href = '/investments'}
                className="text-sm"
              >
                View All Investments
              </Button>
            </div>
            {(investmentBreakdown?.categories || []).map((category: any) => (
              <div key={category.name} className="space-y-2">
                <h5 className="font-medium text-sm text-gray-700 uppercase tracking-wide">{category.name}</h5>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                  {category.products.map((product: any, idx: number) => (
                    <div 
                      key={idx} 
                      className="flex items-center justify-between p-3 bg-gray-50 rounded-lg hover:bg-gray-100 cursor-pointer transition-colors"
                      onClick={() => window.location.href = '/investments'}
                    >
                      <div className="flex items-center space-x-3">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: getCategoryColor(category.name) }}></div>
                        <span className="text-sm font-medium">{product.name}</span>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold">${(product.value / 1000).toFixed(0)}K</div>
                        <div className="text-xs text-gray-500">{product.percentage.toFixed(1)}%</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>



      {/* Advisor Contact Modal */}
      <Dialog open={advisorModalOpen} onOpenChange={setAdvisorModalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Contact Your Wealth Planner</DialogTitle>
            <DialogDescription>
              Send a message to our wealth advisory team
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="bg-gray-50 p-3 rounded-lg">
              <div className="flex items-center space-x-2">
                <Phone className="w-4 h-4 text-gray-600" />
                <span className="text-sm text-gray-700">Wealth Advisory Team</span>
              </div>
              <p className="text-sm text-gray-600 mt-1">+2 8320 1908</p>
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="advisor-message">Your Message</Label>
              <Textarea
                id="advisor-message"
                placeholder="Tell your wealth planner how they can help you..."
                value={advisorMessage}
                onChange={(e) => setAdvisorMessage(e.target.value)}
                rows={4}
                className="resize-none"
              />
            </div>
            
            <div className="flex space-x-2">
              <Button 
                variant="outline" 
                onClick={() => setAdvisorModalOpen(false)}
                className="flex-1"
              >
                Cancel
              </Button>
              <Button 
                onClick={() => advisorMutation.mutate({ message: advisorMessage })}
                disabled={!advisorMessage.trim() || advisorMutation.isPending}
                className="flex-1"
              >
                {advisorMutation.isPending ? "Sending..." : "Send Message"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Recommendation Details Modal */}
      <Dialog open={detailsModalOpen} onOpenChange={setDetailsModalOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selectedRecommendation?.title}</DialogTitle>
            <DialogDescription>
              Detailed analysis and implementation guidance
            </DialogDescription>
          </DialogHeader>
          {selectedRecommendation && (
            <div className="space-y-4">
              <div className="p-4 bg-gray-50 rounded-lg">
                <h4 className="font-semibold mb-2">Recommendation Type</h4>
                <Badge className="mb-2">
                  {selectedRecommendation.type.replace('_', ' ').toUpperCase()}
                </Badge>
                <p className="text-sm text-gray-600">{selectedRecommendation.description}</p>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 border rounded-lg">
                  <h4 className="font-semibold mb-2">Impact Analysis</h4>
                  <AdvisoryMetricUnavailable
                    title="Impact figures unavailable"
                    description="Expected return improvement and risk reduction will appear once real portfolio history is available for calculation."
                  />
                </div>
                
                <div className="p-4 border rounded-lg">
                  <h4 className="font-semibold mb-2">Implementation Steps</h4>
                  <ol className="text-sm space-y-1 list-decimal list-inside">
                    <li>Review current allocation</li>
                    <li>Identify rebalancing targets</li>
                    <li>Execute trades gradually</li>
                    <li>Monitor performance impact</li>
                  </ol>
                </div>
              </div>
              
              <div className="flex space-x-2">
                <Button 
                  onClick={() => {
                    applyRecommendationMutation.mutate(selectedRecommendation.id);
                    setDetailsModalOpen(false);
                  }}
                  disabled={applyRecommendationMutation.isPending}
                >
                  {applyRecommendationMutation.isPending ? "Applying..." : "Apply Recommendation"}
                </Button>
                <Button variant="outline" onClick={() => setDetailsModalOpen(false)}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
