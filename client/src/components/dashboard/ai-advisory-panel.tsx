import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Bot, Lightbulb, TrendingUp, AlertTriangle, Info } from "lucide-react";
import { useAiRecommendations } from "@/hooks/use-portfolio";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";

export default function AiAdvisoryPanel() {
  const { data: recommendations, isLoading } = useAiRecommendations();
  const queryClient = useQueryClient();

  const markAsReadMutation = useMutation({
    mutationFn: (id: number) => api.markRecommendationAsRead(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai-recommendations"] });
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

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg flex items-center justify-center">
              <Bot className="w-4 h-4 text-white" />
            </div>
            <div>
              <CardTitle>Market Insights</CardTitle>
              <p className="text-sm text-gray-500">General information only</p>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="p-4 bg-gray-50 rounded-lg">
              <Skeleton className="h-4 w-3/4 mb-2" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-2/3 mt-1" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 bg-gradient-to-r from-purple-500 to-pink-500 rounded-lg flex items-center justify-center">
            <Bot className="w-4 h-4 text-white" />
          </div>
          <div>
            <CardTitle>Market Insights</CardTitle>
            <p className="text-sm text-gray-500">General information only — not personal advice</p>
          </div>
        </div>
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
                <div className="flex items-start space-x-3">
                  <Icon className={`w-4 h-4 mt-1 ${getIconColor(recommendation.severity)}`} />
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <h4 className={`font-medium ${getTitleColor(recommendation.severity)}`}>
                        {recommendation.title}
                      </h4>
                      {!recommendation.isRead && (
                        <Badge variant="secondary" className="text-xs">General</Badge>
                      )}
                    </div>
                    <p className={`text-sm ${getDescriptionColor(recommendation.severity)}`}>
                      {recommendation.description}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
          <div className="flex items-start space-x-2">
            <Info className="w-3.5 h-3.5 text-gray-400 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-gray-500">
              These insights are general in nature and do not constitute personal financial advice. 
              Contact your adviser before acting on any market commentary.
            </p>
          </div>
        </div>
        
        <Button
          className="w-full mt-4 bg-gradient-to-r from-purple-500 to-pink-500 hover:from-purple-600 hover:to-pink-600"
          onClick={() => {
            window.location.pathname = "/ai-advisory";
          }}
        >
          View Market Insights
        </Button>
      </CardContent>
    </Card>
  );
}
