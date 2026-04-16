import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/contexts/auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, ArrowLeft } from "lucide-react";
import { SiGoogle, SiApple } from "react-icons/si";
import darkBlueLogo from "@assets/DARK_BLUE_LOGO_1776310673148.jpg";

export default function Signup() {
  const { register, isAuthenticated } = useAuth();
  const [, navigate] = useLocation();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [confirmedAge, setConfirmedAge] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isAuthenticated) {
      navigate("/dashboard", { replace: true });
    }
  }, [isAuthenticated]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!agreedTerms) {
      setError("You must agree to the Terms of Service and Privacy Policy");
      return;
    }
    if (!confirmedAge) {
      setError("You must confirm you are at least 18 years old");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setIsLoading(true);
    try {
      await register({ email, password, firstName, lastName });
    } catch (err: any) {
      setError(err.message || "Registration failed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="w-10 h-10 rounded-lg" />
            <span className="text-2xl font-bold text-white">AMAX WEALTH</span>
          </div>
          <h1 className="text-3xl font-bold text-white">Apply for access</h1>
          <p className="text-white">Create your account to get started</p>
        </div>

        <div className="space-y-3">
          <Button
            variant="outline"
            className="w-full bg-slate-800 border-slate-700 text-white hover:bg-slate-700 font-medium h-11"
            disabled
          >
            <SiGoogle className="w-4 h-4 mr-3" />
            Continue with Google
            <span className="ml-auto text-xs text-slate-400">Coming soon</span>
          </Button>
          <Button
            variant="outline"
            className="w-full bg-slate-800 border-slate-700 text-white hover:bg-slate-700 font-medium h-11"
            disabled
          >
            <SiApple className="w-4 h-4 mr-3" />
            Continue with Apple
            <span className="ml-auto text-xs text-slate-400">Coming soon</span>
          </Button>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex-1 h-px bg-slate-700" />
          <span className="text-sm text-white">OR</span>
          <div className="flex-1 h-px bg-slate-700" />
        </div>

        <Card className="bg-slate-800 border-slate-700">
          <CardContent className="pt-6">
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="firstName" className="text-white">First Name</Label>
                  <Input
                    id="firstName"
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="John"
                    required
                    className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400 focus:border-white"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName" className="text-white">Last Name</Label>
                  <Input
                    id="lastName"
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Smith"
                    required
                    className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400 focus:border-white"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="email" className="text-white">Email Address</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="john@example.com"
                  required
                  autoComplete="email"
                  className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400 focus:border-white"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password" className="text-white">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  required
                  autoComplete="new-password"
                  className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400 focus:border-white"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword" className="text-white">Confirm Password</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  required
                  autoComplete="new-password"
                  className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400 focus:border-white"
                />
              </div>

              <div className="space-y-3 pt-2">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="terms"
                    checked={agreedTerms}
                    onCheckedChange={(checked) => setAgreedTerms(checked === true)}
                    className="mt-0.5 border-slate-500 data-[state=checked]:bg-white data-[state=checked]:text-slate-900"
                  />
                  <Label htmlFor="terms" className="text-sm text-white leading-snug cursor-pointer">
                    I agree to the <span className="underline">Terms of Service</span> and <span className="underline">Privacy Policy</span>
                  </Label>
                </div>
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="age"
                    checked={confirmedAge}
                    onCheckedChange={(checked) => setConfirmedAge(checked === true)}
                    className="mt-0.5 border-slate-500 data-[state=checked]:bg-white data-[state=checked]:text-slate-900"
                  />
                  <Label htmlFor="age" className="text-sm text-white leading-snug cursor-pointer">
                    I confirm I am at least 18 years old
                  </Label>
                </div>
              </div>

              <Button
                type="submit"
                disabled={isLoading}
                className="w-full bg-white hover:bg-slate-100 text-slate-900 font-semibold h-11"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Creating account...
                  </>
                ) : (
                  "Create account"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="text-xs text-center text-white">
          This account will be used to complete identity verification and receive financial service communications.
        </p>

        <div className="text-center space-y-3">
          <p className="text-sm text-white">
            Already have an account?{" "}
            <Link href="/login" className="underline hover:text-slate-300">
              Sign in
            </Link>
          </p>
          <Link href="/" className="inline-flex items-center gap-2 text-sm text-white hover:text-slate-300">
            <ArrowLeft className="w-4 h-4" />
            Back to Home
          </Link>
        </div>
      </div>
    </div>
  );
}
