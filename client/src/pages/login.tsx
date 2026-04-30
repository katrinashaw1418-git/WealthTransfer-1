import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/contexts/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Shield, ArrowLeft, CheckCircle2 } from "lucide-react";
import darkBlueLogo from "@assets/AMAX_LOGO_BLUE_1776427512999.jpg";

export default function Login() {
  const { login, isAuthenticated, user } = useAuth();
  const [, navigate] = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Gate on the resolved user object as well as isAuthenticated for
    // defensive clarity — isAuthenticated is derived from !!user but this
    // makes the data dependency explicit for the role branch below.
    if (isAuthenticated && user) {
      // Role-based landing: advisers go to the adviser portal, everyone
      // else (clients, admins until /admin shell exists, undefined role)
      // falls through to the standard client dashboard. No dead-end routes.
      if (user.role === "adviser") {
        navigate("/adviser/dashboard", { replace: true });
      } else {
        navigate("/dashboard", { replace: true });
      }
    }
  }, [isAuthenticated, user?.role]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      // Detect unverified-email response and redirect to verification flow.
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (res.status === 403) {
        const data = await res.json().catch(() => ({}));
        if (data?.code === "email_not_verified") {
          // Trigger a fresh code so the user has something current to enter
          await fetch("/api/auth/resend-otp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: data.email }),
          }).catch(() => {});
          navigate(`/verify-email?pending=1&email=${encodeURIComponent(data.email || username)}`);
          return;
        }
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Login failed");
      }
      // Successful login — defer to context login() for state setup
      await login(username, password);
    } catch (err: any) {
      setError(err.message || "Login failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-sky-50 via-white to-white px-4 py-8 md:px-6 md:py-12">
      <div className="mx-auto grid w-full max-w-6xl gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:gap-10">
        <section className="rounded-3xl border border-sky-100 bg-white p-6 shadow-sm md:p-8 lg:p-10">
          <div className="mb-8 flex items-center gap-3">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="h-11 w-11 rounded-xl" />
            <div>
              <p className="text-xl font-bold tracking-tight text-sky-900 md:text-2xl">
                AMAX WEALTH
              </p>
              <p className="text-xs uppercase tracking-wide text-sky-700/80">
                Investments / Advice
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <h1 className="text-3xl font-bold tracking-tight text-sky-950 md:text-4xl">
              Welcome back
            </h1>
            <p className="max-w-xl text-sm leading-relaxed text-slate-600 md:text-base">
              Sign in to access your dashboard, track portfolio performance, and manage
              your investment workflow with adviser-backed oversight.
            </p>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-sky-100 bg-sky-50/50 p-4">
              <div className="mb-2 flex items-center gap-2 text-sky-900">
                <Shield className="h-4 w-4" />
                <p className="text-sm font-semibold">Secure authentication</p>
              </div>
              <p className="text-xs leading-relaxed text-sky-800/80">
                JWT sessions with encrypted transit and audited access events.
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
              <div className="mb-2 flex items-center gap-2 text-slate-800">
                <CheckCircle2 className="h-4 w-4" />
                <p className="text-sm font-semibold">Adviser-linked journey</p>
              </div>
              <p className="text-xs leading-relaxed text-slate-600">
                Stay aligned with applications, compliance, and portfolio actions.
              </p>
            </div>
          </div>
        </section>

        <aside className="space-y-4">
          <Card className="border-slate-200 shadow-sm">
            <CardHeader className="space-y-1 pb-4">
              <CardTitle className="text-slate-900">Sign In</CardTitle>
              <CardDescription className="text-slate-600">
                Enter your credentials to continue.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label htmlFor="username" className="text-slate-800">Username</Label>
                  <Input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Enter your username"
                    required
                    autoComplete="username"
                    className="border-slate-300 bg-white text-slate-900"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password" className="text-slate-800">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    required
                    autoComplete="current-password"
                    className="border-slate-300 bg-white text-slate-900"
                  />
                </div>

                <Button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-sky-500 font-semibold text-white hover:bg-sky-600"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Signing in...
                    </>
                  ) : (
                    "Sign In"
                  )}
                </Button>

                <div className="text-center">
                  <Link href="/forgot-password" className="text-sm text-sky-700 hover:text-sky-800">
                    Forgot your password?
                  </Link>
                </div>
              </form>
            </CardContent>
          </Card>

          <div className="rounded-2xl border border-slate-200 bg-white p-4 text-center">
            <p className="text-sm text-slate-700">
              Don&apos;t have an account?{" "}
              <Link href="/apply" className="font-medium text-sky-700 underline-offset-2 hover:underline">
                Apply for access
              </Link>
            </p>
            <Link href="/" className="mt-3 inline-flex items-center gap-2 text-sm text-slate-600 hover:text-slate-800">
              <ArrowLeft className="h-4 w-4" />
              Back to Home
            </Link>
          </div>
        </aside>
      </div>
    </div>
  );
}
