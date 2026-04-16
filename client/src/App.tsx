import { Switch, Route, useLocation } from "wouter";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/auth";
import Layout from "@/components/layout/layout";
import Landing from "@/pages/landing";
import Dashboard from "@/pages/dashboard";
import WalletsNew from "@/pages/wallets-new";
import Portfolio from "@/pages/portfolio";
import AiAdvisory from "@/pages/ai-advisory";
import Transactions from "@/pages/transactions";
import Compliance from "@/pages/compliance";
import Investments from "@/pages/investments";
import Login from "@/pages/login";
import Signup from "@/pages/signup";
import ForgotPassword from "@/pages/forgot-password";
import ResetPassword from "@/pages/reset-password";
import NotFound from "@/pages/not-found";
import { Loader2 } from "lucide-react";

function ProtectedApp() {
  const { isAuthenticated, isLoading, token } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !token) {
      navigate("/", { replace: true });
    }
  }, [isLoading, isAuthenticated, token]);

  if (isLoading || (!isAuthenticated && token)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <Loader2 className="w-8 h-8 animate-spin text-amber-500" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <Loader2 className="w-8 h-8 animate-spin text-amber-500" />
      </div>
    );
  }

  return (
    <Layout>
      <Switch>
        <Route path="/dashboard" component={Dashboard} />
        <Route path="/wallets" component={WalletsNew} />
        <Route path="/portfolio" component={Portfolio} />
        <Route path="/ai-advisory" component={AiAdvisory} />
        <Route path="/transactions" component={Transactions} />
        <Route path="/compliance" component={Compliance} />
        <Route path="/investments" component={Investments} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/login" component={Login} />
      <Route path="/signup" component={Signup} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route component={ProtectedApp} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
