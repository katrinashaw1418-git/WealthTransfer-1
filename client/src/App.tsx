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
import PortfolioAdvicePage from "@/pages/portfolio-advice";
import Transactions from "@/pages/transactions";
import Investments from "@/pages/investments";
import FxExchange from "@/pages/fx-exchange";
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
import AdviserDashboardV2 from "@/pages/adviser/dashboard-v2";
import AdviserClientsV2 from "@/pages/adviser/clients-v2";
import AdminDashboard from "@/pages/admin/dashboard";
import AdminApplications from "@/pages/admin/applications";
import AdminAdvisers from "@/pages/admin/advisers";
import AdminAdviserClients from "@/pages/admin/adviser-clients";
import AdminRegistrationInvites from "@/pages/admin/registration-invites";
import AdminAuditLogs from "@/pages/admin/audit-logs";
import AdminOperatorAlerts from "@/pages/admin/operator-alerts";
import AdminProducts from "@/pages/admin/products";
import AdminInstructions from "@/pages/admin/instructions";
import AdminReports from "@/pages/admin/reports";
import AdminCompliance from "@/pages/admin/compliance";
import AdminFeeConsents from "@/pages/admin/fee-consents";
import AdminFees from "@/pages/admin/fees";
import AdminReconciliation from "@/pages/admin/reconciliation";
import AdminBackgroundJobs from "@/pages/admin/background-jobs";
import AdminKillSwitches from "@/pages/admin/kill-switches";
import AdminErrorLog from "@/pages/admin/error-log";
import RegisterInvite from "@/pages/register-invite";
import GoalsPage from "@/pages/goals";
import ReportsPage from "@/pages/reports";
import AccountPage from "@/pages/account";
import AdviserAiPlanningV2 from "@/pages/adviser/ai-planning-v2";
import AdviserCompliancePage from "@/pages/adviser/compliance";
import AiInsightsPage from "@/pages/ai-insights";
import AdviserReportsV2 from "@/pages/adviser/reports-v2";
import { uiFeatures } from "@/uiFeatures";
import { Loader2 } from "lucide-react";

// -----------------------------------------------------------------------------
// Route exposure (Slice 2 — legacy audit)
// - Client: /wallets, /transactions, /investments, /fx-exchange use uiFeatures;
//   /crypto, /remittance always redirect; /client/wealth-planner, /client/instructions,
//   /client/advice/:id redirect until legacy UI pass (components remain on disk).
// - Adviser: /adviser/clients/:id* redirect to /adviser/clients (no client-detail).
// - Admin: /admin/* only mounts for role === "admin" (ProtectedApp); non-admins are
//   redirected away. Prohibited-term UI pass is tracked separately (admin slice).
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
        <Route path="/adviser/dashboard" component={AdviserDashboardV2} />
        <Route path="/adviser/ai-planning" component={AdviserAiPlanningV2} />
        <Route path="/adviser/clients" component={AdviserClientsV2} />
        <Route path="/adviser/clients/:id/holdings"><Redirect to="/adviser/clients" /></Route>
        <Route path="/adviser/clients/:id"><Redirect to="/adviser/clients" /></Route>
        <Route path="/adviser/reports" component={AdviserReportsV2} />
        <Route path="/adviser/compliance" component={AdviserCompliancePage} />
        <Route path="/adviser/workflow"><Redirect to="/adviser/ai-planning" /></Route>
        <Route path="/adviser/business"><Redirect to="/adviser/dashboard" /></Route>
        <Route path="/adviser/products"><Redirect to="/adviser/clients" /></Route>
        <Route path="/adviser/fcs-explainer"><Redirect to="/adviser/compliance" /></Route>
        <Route path="/adviser/instructions"><Redirect to="/adviser/ai-planning" /></Route>
        <Route path="/adviser/tasks"><Redirect to="/adviser/ai-planning" /></Route>
        <Route path="/adviser/fee-consents"><Redirect to="/adviser/compliance" /></Route>
        <Route path="/adviser/fees"><Redirect to="/adviser/compliance" /></Route>
        <Route path="/fee-consents"><Redirect to="/adviser/compliance" /></Route>
        <Route path="/fee-rules"><Redirect to="/adviser/compliance" /></Route>
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
        <Route path="/admin/operator-alerts" component={AdminOperatorAlerts} />
        <Route path="/admin/products" component={AdminProducts} />
        <Route path="/admin/instructions" component={AdminInstructions} />
        <Route path="/admin/reports" component={AdminReports} />
        <Route path="/admin/compliance" component={AdminCompliance} />
        <Route path="/admin/fee-consents" component={AdminFeeConsents} />
        <Route path="/admin/fees" component={AdminFees} />
        <Route path="/admin/reconciliation" component={AdminReconciliation} />
        <Route path="/admin/background-jobs" component={AdminBackgroundJobs} />
        <Route path="/admin/kill-switches" component={AdminKillSwitches} />
        <Route path="/admin/error-log" component={AdminErrorLog} />
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
        <Route path="/wallets">
          {!uiFeatures.showWallets ? <Redirect to="/dashboard" /> : <WalletsNew />}
        </Route>
        <Route path="/portfolio" component={PortfolioAdvicePage} />
        <Route path="/ai-insights" component={AiInsightsPage} />
        <Route path="/goals" component={GoalsPage} />
        <Route path="/reports" component={ReportsPage} />
        <Route path="/account" component={AccountPage} />
        <Route path="/ai-advisory"><Redirect to="/ai-insights" /></Route>
        <Route path="/transactions">
          {!uiFeatures.showExecutionActions ? <Redirect to="/dashboard" /> : <Transactions />}
        </Route>
        <Route path="/compliance"><Redirect to="/account" /></Route>
        <Route path="/risk-assessment"><Redirect to="/goals" /></Route>
        <Route path="/investments">
          {!uiFeatures.showBuySellTerms ? <Redirect to="/dashboard" /> : <Investments />}
        </Route>
        <Route path="/fx-exchange">
          {!uiFeatures.showFx ? <Redirect to="/dashboard" /> : <FxExchange />}
        </Route>
        <Route path="/crypto">
          <Redirect to="/dashboard" />
        </Route>
        <Route path="/remittance">
          <Redirect to="/dashboard" />
        </Route>
        <Route path="/fee-consents"><Redirect to="/reports" /></Route>
        <Route path="/fee-rules"><Redirect to="/reports" /></Route>
        <Route path="/legal" component={Legal} />
        <Route path="/client/instructions"><Redirect to="/reports" /></Route>
        <Route path="/client/fee-consents"><Redirect to="/reports" /></Route>
        <Route path="/client/fees"><Redirect to="/reports" /></Route>
        <Route path="/client/wealth-planner"><Redirect to="/goals" /></Route>
        <Route path="/client/advice/:id"><Redirect to="/reports" /></Route>
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
