import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/contexts/auth";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, Shield, ArrowLeft } from "lucide-react";
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
    <div className="min-h-screen bg-blue-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="w-10 h-10 rounded-lg" />
            <span className="text-2xl font-bold text-blue-900">AMAX WEALTH</span>
          </div>
          <h1 className="text-3xl font-bold text-blue-900">Welcome back</h1>
          <p className="text-blue-900">Sign in to your wealth management platform</p>
        </div>

        <Card className="bg-white border-blue-100 shadow-sm">
          <CardHeader>
            <CardTitle className="text-blue-900">Sign In</CardTitle>
            <CardDescription className="text-blue-900">
              Enter your credentials to access your portfolio
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
                <Label htmlFor="username" className="text-blue-900">Username</Label>
                <Input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter your username"
                  required
                  autoComplete="username"
                  className="bg-white border-blue-200 text-blue-900 placeholder:text-gray-400 focus:border-blue-500"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-blue-900">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  autoComplete="current-password"
                  className="bg-white border-blue-200 text-blue-900 placeholder:text-gray-400 focus:border-blue-500"
                />
              </div>

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full bg-sky-500 hover:bg-sky-600 text-white font-semibold"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Signing in...
                  </>
                ) : (
                  "Sign In"
                )}
              </Button>
              <div className="text-center">
                <Link href="/forgot-password" className="text-sm text-blue-900 hover:text-blue-700">
                  Forgot your password?
                </Link>
              </div>
            </form>
          </CardContent>
        </Card>

        <div className="flex items-center gap-2 text-blue-900 text-sm justify-center">
          <Shield className="w-4 h-4" />
          <span>256-bit encrypted · JWT authenticated · Audit logged</span>
        </div>

        <div className="text-center space-y-3">
          <p className="text-sm text-blue-900">
            Don't have an account?{" "}
            <Link href="/apply" className="underline hover:text-blue-700">
              Apply for access
            </Link>
          </p>
          <Link href="/" className="inline-flex items-center gap-2 text-sm text-blue-900 hover:text-blue-700">
            <ArrowLeft className="w-4 h-4" />
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
