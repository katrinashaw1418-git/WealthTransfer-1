import { Switch, Route, useLocation } from "wouter";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/auth";
import Layout from "@/components/layout/layout";
import AdviserLayout from "@/components/layout/adviser-layout";
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
import VerifyEmail from "@/pages/verify-email";
import Apply from "@/pages/apply";
import Invest from "@/pages/invest";
import ApplicationStatus from "@/pages/application-status";
import ForgotPassword from "@/pages/forgot-password";
import ResetPassword from "@/pages/reset-password";
import Onboarding from "@/pages/onboarding";
import Legal from "@/pages/legal";
import NotFound from "@/pages/not-found";
import AdviserDashboard from "@/pages/adviser/dashboard";
import AdviserClients from "@/pages/adviser/clients";
import AdviserClientDetail from "@/pages/adviser/client-detail";
import AdviserClientHoldings from "@/pages/adviser/client-holdings";
import AdviserTasks from "@/pages/adviser/tasks";
import AdviserReports from "@/pages/adviser/reports";
import AdviserProducts from "@/pages/adviser/products";
import AdviserInstructions from "@/pages/adviser/instructions";
import AdviserWorkflow from "@/pages/adviser/workflow";
import AdviserBusiness from "@/pages/adviser/business";
import ClientInstructions from "@/pages/client-instructions";
import { Loader2 } from "lucide-react";

// -----------------------------------------------------------------------------
// Two distinct portals, picked by user role:
//   - Advisers see <AdviserLayout> with the dark sidebar + top search shell and
//     adviser-only routes registered.
//   - Everyone else (regular clients) keeps the original <Layout> and the
//     client-app routes — the existing client app stays untouched.
// Shared `/legal` route is registered in both shells so each user sees it
// inside their own portal chrome.
// -----------------------------------------------------------------------------
function AdviserApp() {
  return (
    <AdviserLayout>
      <Switch>
        <Route path="/adviser/dashboard" component={AdviserDashboard} />
        <Route path="/adviser/workflow" component={AdviserWorkflow} />
        <Route path="/adviser/business" component={AdviserBusiness} />
        <Route path="/adviser/clients" component={AdviserClients} />
        <Route path="/adviser/clients/:id/holdings" component={AdviserClientHoldings} />
        <Route path="/adviser/clients/:id" component={AdviserClientDetail} />
        <Route path="/adviser/products" component={AdviserProducts} />
        <Route path="/adviser/instructions" component={AdviserInstructions} />
        <Route path="/adviser/tasks" component={AdviserTasks} />
        <Route path="/adviser/reports" component={AdviserReports} />
        <Route path="/legal" component={Legal} />
        <Route component={NotFound} />
      </Switch>
    </AdviserLayout>
  );
}

function ClientApp() {
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
        <Route path="/legal" component={Legal} />
        <Route path="/client/instructions" component={ClientInstructions} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function ProtectedApp() {
  const { isAuthenticated, isLoading, token, user } = useAuth();
  const [location, navigate] = useLocation();

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !token) {
      navigate("/", { replace: true });
    }
  }, [isLoading, isAuthenticated, token]);

  // If the user is an adviser but the URL is a non-adviser path (e.g. they
  // bookmarked /dashboard), bounce them to the adviser shell entry. Same in
  // reverse for a client landing on /adviser/*.
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    const isAdviser = user.role === "adviser";
    if (isAdviser && !location.startsWith("/adviser") && !location.startsWith("/legal")) {
      navigate("/adviser/dashboard", { replace: true });
    }
    if (!isAdviser && location.startsWith("/adviser")) {
      navigate("/dashboard", { replace: true });
    }
  }, [isAuthenticated, user, location]);

  if (isLoading || (!isAuthenticated && token) || !isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <Loader2 className="w-8 h-8 animate-spin text-amber-500" />
      </div>
    );
  }

  return user?.role === "adviser" ? <AdviserApp /> : <ClientApp />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Landing} />
      <Route path="/login" component={Login} />
      <Route path="/apply" component={Apply} />
      <Route path="/invest" component={Invest} />
      <Route path="/application-status" component={ApplicationStatus} />
      <Route path="/signup" component={Signup} />
      <Route path="/verify-email" component={VerifyEmail} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      <Route path="/onboarding" component={Onboarding} />
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
