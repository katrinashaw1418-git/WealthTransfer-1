import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowLeft, Clock, CheckCircle2, XCircle, Loader2, FileSearch } from "lucide-react";
import darkBlueLogo from "@assets/DARK_BLUE_LOGO_1776310673148.jpg";

interface ApplicationData {
  status: string;
  fullName: string;
  email: string;
  createdAt: string;
  reviewedAt: string | null;
}

export default function ApplicationStatus() {
  const [, navigate] = useLocation();
  const [email, setEmail] = useState("");
  const [application, setApplication] = useState<ApplicationData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const emailParam = params.get("email");
    if (emailParam) {
      setEmail(emailParam);
      checkStatus(emailParam);
    }
  }, []);

  async function checkStatus(emailToCheck?: string) {
    const target = emailToCheck || email;
    if (!target) return;
    setError(null);
    setIsLoading(true);
    setChecked(true);
    try {
      const res = await fetch(`/api/applications/status/${encodeURIComponent(target)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Application not found");
      }
      setApplication(await res.json());
    } catch (err: any) {
      setError(err.message);
      setApplication(null);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDemoApprove() {
    if (!application) return;
    setIsLoading(true);
    try {
      await fetch(`/api/applications/approve/${encodeURIComponent(application.email)}`, { method: "POST" });
      await checkStatus(application.email);
    } catch {
      setError("Failed to process");
    } finally {
      setIsLoading(false);
    }
  }

  const statusConfig: Record<string, { icon: any; label: string; color: string; bg: string }> = {
    submitted: { icon: Clock, label: "Application Submitted", color: "text-blue-600", bg: "bg-blue-100" },
    under_review: { icon: FileSearch, label: "Under Review", color: "text-amber-600", bg: "bg-amber-100" },
    approved: { icon: CheckCircle2, label: "Approved", color: "text-green-600", bg: "bg-green-100" },
    declined: { icon: XCircle, label: "Declined", color: "text-red-600", bg: "bg-red-100" },
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="w-10 h-10 rounded-lg" />
            <span className="text-2xl font-bold text-white">AMAX WEALTH</span>
          </div>
          <h1 className="text-3xl font-bold text-white">Application Status</h1>
          <p className="text-slate-300">Check the status of your access application</p>
        </div>

        {!checked && (
          <Card className="bg-slate-800 border-slate-700">
            <CardContent className="pt-6">
              <form onSubmit={(e) => { e.preventDefault(); checkStatus(); }} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="statusEmail" className="text-white">Email address</Label>
                  <Input
                    id="statusEmail"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Enter the email you used to apply"
                    required
                    className="bg-slate-700 border-slate-600 text-white placeholder:text-slate-400 focus:border-white"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={isLoading || !email}
                  className="w-full bg-white hover:bg-slate-100 text-slate-900 font-semibold"
                >
                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Check Status"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {error && checked && (
          <Card className="bg-slate-800 border-slate-700">
            <CardContent className="pt-6 text-center space-y-4">
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
              <Button
                variant="outline"
                onClick={() => { setChecked(false); setError(null); }}
                className="text-white border-slate-600 hover:bg-slate-700"
              >
                Try another email
              </Button>
            </CardContent>
          </Card>
        )}

        {application && !error && (
          <Card className="bg-slate-800 border-slate-700">
            <CardContent className="pt-6 space-y-5">
              {(() => {
                const config = statusConfig[application.status] || statusConfig.submitted;
                const Icon = config.icon;
                return (
                  <div className="text-center space-y-3">
                    <div className={`w-16 h-16 ${config.bg} rounded-full flex items-center justify-center mx-auto`}>
                      <Icon className={`w-8 h-8 ${config.color}`} />
                    </div>
                    <h2 className={`text-xl font-bold ${config.color}`}>{config.label}</h2>
                  </div>
                );
              })()}

              <div className="bg-slate-700/50 rounded-lg p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-400">Name</span>
                  <span className="text-white">{application.fullName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Email</span>
                  <span className="text-white">{application.email}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Submitted</span>
                  <span className="text-white">{new Date(application.createdAt).toLocaleDateString()}</span>
                </div>
                {application.reviewedAt && (
                  <div className="flex justify-between">
                    <span className="text-slate-400">Reviewed</span>
                    <span className="text-white">{new Date(application.reviewedAt).toLocaleDateString()}</span>
                  </div>
                )}
              </div>

              {application.status === "approved" && (
                <div className="space-y-3">
                  <p className="text-sm text-green-300 text-center">
                    Your application has been approved. Please create your account credentials to continue.
                  </p>
                  <Button
                    className="w-full bg-white hover:bg-slate-100 text-slate-900 font-semibold"
                    onClick={() => navigate("/signup?email=" + encodeURIComponent(application.email))}
                  >
                    Create Account
                  </Button>
                </div>
              )}

              {(application.status === "submitted" || application.status === "under_review") && (
                <div className="space-y-3">
                  <p className="text-sm text-slate-400 text-center">
                    Your application is being reviewed. You will be contacted when a decision is made.
                  </p>
                  <div className="border border-dashed border-slate-600 rounded-lg p-3 text-center">
                    <p className="text-xs text-slate-500 mb-2">Demo only — simulate approval</p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleDemoApprove}
                      disabled={isLoading}
                      className="text-white border-slate-600 hover:bg-slate-700"
                    >
                      {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Approve Application"}
                    </Button>
                  </div>
                </div>
              )}

              {application.status === "declined" && (
                <p className="text-sm text-red-300 text-center">
                  Unfortunately, your application was not approved at this time. Please contact us at +61 2 8320 1908 for more information.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        <div className="text-center space-y-3">
          <p className="text-sm text-white">
            Haven't applied yet?{" "}
            <Link href="/apply" className="underline hover:text-slate-300">
              Apply for Access
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
