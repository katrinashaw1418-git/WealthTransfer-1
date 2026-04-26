import { Switch, Route, Redirect, useLocation } from "wouter";
import { useEffect } from "react";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/contexts/auth";
import Layout from "@/components/layout/layout";
import AdviserLayout from "@/components/layout/adviser-layout";
import AdminLayout from "@/components/layout/admin-layout";
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
import AdviserFeeConsents from "@/pages/adviser/fee-consents";
import AdviserFees from "@/pages/adviser/fees";
import AdminDashboard from "@/pages/admin/dashboard";
import AdminApplications from "@/pages/admin/applications";
import AdminAdvisers from "@/pages/admin/advisers";
import AdminAdviserClients from "@/pages/admin/adviser-clients";
import AdminRegistrationInvites from "@/pages/admin/registration-invites";
import AdminAuditLogs from "@/pages/admin/audit-logs";
import AdminProducts from "@/pages/admin/products";
import AdminInstructions from "@/pages/admin/instructions";
import AdminReports from "@/pages/admin/reports";
import AdminCompliance from "@/pages/admin/compliance";
import AdminFeeConsents from "@/pages/admin/fee-consents";
import AdminFees from "@/pages/admin/fees";
import AdminReconciliation from "@/pages/admin/reconciliation";
import ClientInstructions from "@/pages/client-instructions";
import ClientFeeConsents from "@/pages/client/fee-consents";
import ClientFees from "@/pages/fees";
import RegisterInvite from "@/pages/register-invite";
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
        <Route path="/adviser"><Redirect to="/adviser/dashboard" /></Route>
        <Route path="/adviser/"><Redirect to="/adviser/dashboard" /></Route>
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
        <Route path="/adviser/fee-consents" component={AdviserFeeConsents} />
        <Route path="/adviser/fees" component={AdviserFees} />
        <Route path="/legal" component={Legal} />
        <Route component={NotFound} />
      </Switch>
    </AdviserLayout>
  );
}

function AdminApp() {
  return (
    <AdminLayout>
      <Switch>
        <Route path="/admin"><Redirect to="/admin/dashboard" /></Route>
        <Route path="/admin/"><Redirect to="/admin/dashboard" /></Route>
        <Route path="/admin/dashboard" component={AdminDashboard} />
        <Route path="/admin/applications" component={AdminApplications} />
        <Route path="/admin/registration-invites" component={AdminRegistrationInvites} />
        <Route path="/admin/advisers" component={AdminAdvisers} />
        <Route path="/admin/adviser-clients" component={AdminAdviserClients} />
        <Route path="/admin/audit-logs" component={AdminAuditLogs} />
        <Route path="/admin/products" component={AdminProducts} />
        <Route path="/admin/instructions" component={AdminInstructions} />
        <Route path="/admin/reports" component={AdminReports} />
        <Route path="/admin/compliance" component={AdminCompliance} />
        <Route path="/admin/fee-consents" component={AdminFeeConsents} />
        <Route path="/admin/fees" component={AdminFees} />
        <Route path="/admin/reconciliation" component={AdminReconciliation} />
        <Route path="/legal" component={Legal} />
        <Route component={NotFound} />
      </Switch>
    </AdminLayout>
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
        <Route path="/client/fee-consents" component={ClientFeeConsents} />
        <Route path="/client/fees" component={ClientFees} />
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

  // Role-based redirects: keep each persona inside their own shell.
  // - admin   → /admin/*
  // - adviser → /adviser/*
  // - client  → /dashboard, /wallets, etc.
  // /legal is shared, so it's allowed in any shell.
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    const role = user.role;
    const isLegal = location.startsWith("/legal");
    if (role === "admin" && !location.startsWith("/admin") && !isLegal) {
      navigate("/admin/dashboard", { replace: true });
      return;
    }
    if (role === "adviser" && !location.startsWith("/adviser") && !isLegal) {
      navigate("/adviser/dashboard", { replace: true });
      return;
    }
    if (role !== "admin" && location.startsWith("/admin")) {
      navigate(role === "adviser" ? "/adviser/dashboard" : "/dashboard", { replace: true });
      return;
    }
    if (role !== "adviser" && location.startsWith("/adviser")) {
      navigate(role === "admin" ? "/admin/dashboard" : "/dashboard", { replace: true });
      return;
    }
  }, [isAuthenticated, user, location]);

  if (isLoading || (!isAuthenticated && token) || !isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-900">
        <Loader2 className="w-8 h-8 animate-spin text-white" />
      </div>
    );
  }

  if (user?.role === "admin") return <AdminApp />;
  if (user?.role === "adviser") return <AdviserApp />;
  return <ClientApp />;
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
      <Route path="/register/invite" component={RegisterInvite} />
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
