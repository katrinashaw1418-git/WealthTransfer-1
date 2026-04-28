import { useState, useEffect } from "react";
import { useLocation, Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ArrowLeft, Clock, CheckCircle2, XCircle, Loader2, FileSearch } from "lucide-react";
import darkBlueLogo from "@assets/AMAX_LOGO_BLUE_1776427512999.jpg";

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
    <div className="min-h-screen bg-blue-50 flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img src={darkBlueLogo} alt="AMAX Wealth" className="w-10 h-10 rounded-lg" />
            <span className="text-2xl font-bold text-blue-900">AMAX WEALTH</span>
          </div>
          <h1 className="text-3xl font-bold text-blue-900">Application Status</h1>
          <p className="text-blue-700">Check the status of your access application</p>
        </div>

        {!checked && (
          <Card className="bg-white border-blue-100 shadow-sm">
            <CardContent className="pt-6">
              <form onSubmit={(e) => { e.preventDefault(); checkStatus(); }} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="statusEmail" className="text-blue-900">Email address</Label>
                  <Input
                    id="statusEmail"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="Enter the email you used to apply"
                    required
                    className="bg-white border-blue-200 text-blue-900 placeholder:text-gray-400 focus:border-blue-500"
                  />
                </div>
                <Button
                  type="submit"
                  disabled={isLoading || !email}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                >
                  {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Check Status"}
                </Button>
              </form>
            </CardContent>
          </Card>
        )}

        {error && checked && (
          <Card className="bg-white border-blue-100 shadow-sm">
            <CardContent className="pt-6 text-center space-y-4">
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
              <Button
                variant="outline"
                onClick={() => { setChecked(false); setError(null); }}
                className="text-blue-900 border-blue-200 hover:bg-blue-50"
              >
                Try another email
              </Button>
            </CardContent>
          </Card>
        )}

        {application && !error && (
          <Card className="bg-white border-blue-100 shadow-sm">
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

              <div className="bg-blue-50 rounded-lg p-4 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Name</span>
                  <span className="text-blue-900">{application.fullName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Email</span>
                  <span className="text-blue-900">{application.email}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Submitted</span>
                  <span className="text-blue-900">{new Date(application.createdAt).toLocaleDateString()}</span>
                </div>
                {application.reviewedAt && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">Reviewed</span>
                    <span className="text-blue-900">{new Date(application.reviewedAt).toLocaleDateString()}</span>
                  </div>
                )}
              </div>

              {application.status === "approved" && (
                <div className="space-y-3">
                  <p className="text-sm text-green-300 text-center">
                    Your application has been approved. Please create your account credentials to continue.
                  </p>
                  <Button
                    className="w-full bg-sky-500 hover:bg-sky-600 text-white font-semibold"
                    onClick={() => navigate("/signup?email=" + encodeURIComponent(application.email))}
                  >
                    Create Account
                  </Button>
                </div>
              )}

              {(application.status === "submitted" || application.status === "under_review") && (
                <div className="space-y-3">
                  <p className="text-sm text-gray-500 text-center">
                    Your application is being reviewed. You will be contacted when a decision is made.
                  </p>
                  {/*
                    TASK #366 — The local-dev "self-approve" shortcut is hidden in
                    production builds. The matching server endpoint
                    `/api/applications/approve/:email` already returns 403 unless
                    `isLocalDev` is true, so the previous always-rendered
                    "Demo only — simulate approval" panel was leaking an internal
                    test affordance into the client-facing page even though the
                    button never actually worked in production. We render it only
                    when Vite's DEV flag is set so the production bundle ships
                    nothing user-visible from this branch.
                  */}
                  {import.meta.env.DEV && (
                    <div className="border border-dashed border-blue-200 rounded-lg p-3 text-center">
                      <p className="text-xs text-gray-400 mb-2">Local development only</p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleDemoApprove}
                        disabled={isLoading}
                        className="text-blue-900 border-blue-200 hover:bg-blue-50"
                        data-testid="button-local-dev-approve-application"
                      >
                        {isLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : "Approve Application"}
                      </Button>
                    </div>
                  )}
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
          <p className="text-sm text-blue-900">
            Haven't applied yet?{" "}
            <Link href="/apply" className="underline hover:text-blue-700">
              Apply for Access
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
