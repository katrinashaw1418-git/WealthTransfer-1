import { useState } from "react";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, TrendingUp, ArrowLeft, CheckCircle2, KeyRound } from "lucide-react";

export default function ForgotPassword() {
  const [username, setUsername] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  // Dev-only: backend returns raw token outside production for testing
  const [devToken, setDevToken] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      const res = await apiRequest("POST", "/api/auth/forgot-password", { username });
      const data = await res.json();
      if (data.resetToken) {
        setDevToken(data.resetToken);
      }
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message || "Failed to process request.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-2 mb-4">
            <div className="w-10 h-10 bg-amber-500 rounded-lg flex items-center justify-center">
              <TrendingUp className="w-6 h-6 text-slate-900" />
            </div>
            <span className="text-2xl font-bold text-blue-900">AMAX</span>
          </div>
          <h1 className="text-2xl font-bold text-blue-900">Reset your password</h1>
          <p className="text-gray-500">Enter your username to request a password reset</p>
        </div>

        <Card className="bg-white border-blue-100 shadow-sm">
          <CardHeader>
            <CardTitle className="text-blue-900">Account Recovery</CardTitle>
            <CardDescription className="text-gray-500">
              Enter your username to begin the password reset process
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!submitted ? (
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="username" className="text-blue-700">Username</Label>
                  <Input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Enter your username"
                    required
                    className="bg-white border-blue-200 text-blue-900 placeholder:text-gray-400 focus:border-amber-500"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-amber-500 hover:bg-amber-400 text-slate-900 font-semibold"
                >
                  {isLoading ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Processing...</>
                  ) : "Request Password Reset"}
                </Button>
              </form>
            ) : (
              <div className="space-y-4">
                <Alert className="border-green-500 bg-green-500/10">
                  <CheckCircle2 className="h-4 w-4 text-green-500" />
                  <AlertDescription className="text-green-200">
                    If that account exists, a password reset link has been sent.
                  </AlertDescription>
                </Alert>

                {devToken && (
                  <Alert className="border-amber-500 bg-amber-500/10">
                    <KeyRound className="h-4 w-4 text-amber-500" />
                    <AlertDescription className="text-amber-200">
                      <span className="text-xs font-semibold uppercase tracking-wide text-amber-400 block mb-1">Development mode — token visible for testing</span>
                      <strong className="block font-mono text-sm break-all text-amber-100 bg-blue-50 p-2 rounded">
                        {devToken}
                      </strong>
                      <span className="text-xs text-gray-500 mt-1 block">Expires in 1 hour. Single use only.</span>
                    </AlertDescription>
                  </Alert>
                )}

                <Link href={`/reset-password${devToken ? `?token=${devToken}` : ""}`}>
                  <Button className="w-full bg-amber-500 hover:bg-amber-400 text-slate-900 font-semibold">
                    Go to Reset Password
                  </Button>
                </Link>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="text-center">
          <Link href="/login" className="text-gray-500 hover:text-amber-400 text-sm flex items-center justify-center gap-1">
            <ArrowLeft className="w-3 h-3" />
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
