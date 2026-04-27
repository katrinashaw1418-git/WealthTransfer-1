import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PlusCircle, ChevronRight, TrendingUp } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { InvestmentProduct } from "@shared/schema";

export default function QuickActions() {
  const { data: cryptoProducts, isLoading } = useQuery<InvestmentProduct[]>({
    queryKey: ["/api/investment-products", { category: "crypto" }],
    queryFn: () => api.getInvestmentProducts({ category: "crypto" }),
  });

  const handleTrade = (productId: number) => {
    window.location.pathname = `/investments/${productId}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick Actions</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {isLoading && (
            <>
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </>
          )}

          {!isLoading && (!cryptoProducts || cryptoProducts.length === 0) && (
            <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-center">
              <p className="text-sm font-medium text-gray-700">No crypto products available</p>
              <p className="mt-1 text-xs text-gray-500">
                Trading shortcuts appear here once your adviser enables crypto products on your shelf.
              </p>
            </div>
          )}

          {!isLoading && cryptoProducts?.map((product) => (
            <Button
              key={product.id}
              variant="outline"
              className="w-full justify-between p-4 h-auto"
              onClick={() => handleTrade(product.id)}
              data-testid={`button-trade-${product.id}`}
            >
              <div className="flex items-center space-x-3">
                <TrendingUp className="w-4 h-4 text-orange-600" />
                <span className="font-medium">Trade {product.name}</span>
              </div>
              <ChevronRight className="w-4 h-4" />
            </Button>
          ))}

          <Button
            variant="outline"
            className="w-full justify-between p-4 h-auto"
            onClick={() => { window.location.pathname = "/investments"; }}
            data-testid="button-view-investments"
          >
            <div className="flex items-center space-x-3">
              <PlusCircle className="w-4 h-4 text-secondary" />
              <span className="font-medium">View all investments</span>
            </div>
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
