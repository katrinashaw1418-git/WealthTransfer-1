import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/contexts/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, ArrowLeft, ShieldCheck } from "lucide-react";
import darkBlueLogo from "@assets/AMAX_LOGO_BLUE_1776427512999.jpg";

export default function Signup() {
  const { register, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [applicationName, setApplicationName] = useState("");
  const [verified, setVerified] = useState(false);
  const [verifying, setVerifying] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      navigate("/onboarding", { replace: true });
    }
  }, [isAuthenticated]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const emailParam = params.get("email");
    if (emailParam) {
      setEmail(emailParam);
      verifyApproval(emailParam);
    }
  }, []);

  async function verifyApproval(emailToCheck: string) {
    setVerifying(true);
    setError(null);
    try {
      const res = await fetch(`/api/applications/status/${encodeURIComponent(emailToCheck)}`);
      if (!res.ok) {
        setError("No approved application found for this email. Please apply first.");
        setVerified(false);
        return;
      }
      const data = await res.json();
      if (data.status !== "approved") {
        setError(`Your application status is "${data.status}". You can only create an account after your application is approved.`);
        setVerified(false);
        return;
      }
      setApplicationName(data.fullName);
      setVerified(true);
    } catch {
      setError("Failed to verify application status.");
      setVerified(false);
    } finally {
      setVerifying(false);
    }
  }

  async function handleCheckEmail(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    await verifyApproval(email);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    const nameParts = applicationName.split(" ");
    const firstName = nameParts[0] || "User";
    const lastName = nameParts.slice(1).join(" ") || "Account";

    setIsLoading(true);
    try {
      const result = await register({ email, password, firstName, lastName });
      // Stash dev OTP for the verify page to display when email isn't configured
      if (result.devOtp) {
        sessionStorage.setItem("amax_dev_otp", result.devOtp);
      }
      navigate(`/verify-email?pending=1&email=${encodeURIComponent(email)}`, { replace: true });
    } catch (err: any) {
      setError(err.message || "Account creation failed. Please try again.");
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
          <h1 className="text-3xl font-bold text-blue-900">Create Account</h1>
          <p className="text-blue-700">Set up your login credentials to continue onboarding</p>
        </div>

        {!verified && !verifying && (
          <Card className="bg-white border-blue-100 shadow-sm">
            <CardContent className="pt-6">
              <form onSubmit={handleCheckEmail} className="space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <p className="text-sm text-blue-700">
                  Enter the email address you used in your application to verify your approval status.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="verifyEmail" className="text-blue-900">Email address</Label>
                  <Input
                    id="verifyEmail"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="john@example.com"
                    required
                    className="bg-white border-blue-200 text-blue-900 placeholder:text-gray-400 focus:border-blue-500"
                  />
                </div>
                <Button
                  type="submit"
                  className="w-full bg-sky-500 hover:bg-sky-600 text-white font-semibold"
                >
                  Verify Application
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {verifying && (
          <Card className="bg-white border-blue-100 shadow-sm">
            <CardContent className="pt-6 text-center py-10">
              <Loader2 className="w-8 h-8 animate-spin text-blue-900 mx-auto mb-3" />
              <p className="text-blue-700">Verifying your application...</p>
            </CardContent>
          </Card>
        )}

        {verified && (
          <>
            <div className="flex items-center gap-3 bg-green-900/30 border border-green-700 rounded-lg p-3">
              <ShieldCheck className="w-5 h-5 text-green-400 flex-shrink-0" />
              <div>
                <p className="text-sm text-green-300 font-medium">Application approved</p>
                <p className="text-xs text-green-400">{applicationName} · {email}</p>
              </div>
            </div>

            <Card className="bg-white border-blue-100 shadow-sm">
              <CardContent className="pt-6">
                <form onSubmit={handleSubmit} className="space-y-4">
                  {error && (
                    <Alert variant="destructive">
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="password" className="text-blue-900">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Minimum 8 characters"
                      required
                      autoComplete="new-password"
                      className="bg-white border-blue-200 text-blue-900 placeholder:text-gray-400 focus:border-blue-500"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword" className="text-blue-900">Confirm password</Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter password"
                      required
                      autoComplete="new-password"
                      className="bg-white border-blue-200 text-blue-900 placeholder:text-gray-400 focus:border-blue-500"
                    />
                  </div>

                  <Button
                    type="submit"
                    disabled={isLoading}
                    className="w-full bg-sky-500 hover:bg-sky-600 text-white font-semibold h-11"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Creating account...
                      </>
                    ) : (
                      "Create Account & Continue"
                    )}
                  </Button>
                </form>
              </CardContent>
            </Card>
          </>
        )}

        <div className="text-center space-y-3">
          <p className="text-sm text-blue-900">
            Haven't applied yet?{" "}
            <Link href="/apply" className="underline hover:text-blue-700">
              Apply for Access
            </Link>
          </p>
          <p className="text-sm text-blue-900">
            Already have an account?{" "}
            <Link href="/login" className="underline hover:text-blue-700">
              Sign in
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
