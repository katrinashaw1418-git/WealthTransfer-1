import { useEffect, useState } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/contexts/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Loader2, ShieldCheck, AlertTriangle, CheckCircle2 } from "lucide-react";

// Session 14 — registration-invite activation page.
// Reads ?invite=... from the URL, validates it server-side, then collects
// password + confirm. Email and role come from the server-side invite row and
// CANNOT be edited from this form (they are admin-issued). Username is derived
// from the email server-side. firstName/lastName start empty and are filled in
// later via profile/KYC.

interface ValidatedInvite {
  email: string;
  role: "client" | "adviser" | "admin";
  expiresAt: string;
}

type ValidateState =
  | { kind: "loading" }
  | { kind: "ok"; invite: ValidatedInvite }
  | { kind: "error"; message: string };

const ROLE_LABEL: Record<string, string> = {
  client: "Client",
  adviser: "Adviser",
  admin: "Administrator",
};

export default function RegisterInvite() {
  const { loginWithJwt } = useAuth();
  const [, navigate] = useLocation();

  const [invite, setInvite] = useState<string>("");
  const [validation, setValidation] = useState<ValidateState>({ kind: "loading" });

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // 1. Validate the invite on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const i = (params.get("invite") || "").trim();
    if (!i) {
      setValidation({ kind: "error", message: "No invitation in the link." });
      return;
    }
    setInvite(i);
    fetch(`/api/auth/registration-invites/validate?invite=${encodeURIComponent(i)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.valid) {
          setValidation({
            kind: "ok",
            invite: { email: body.email, role: body.role, expiresAt: body.expiresAt },
          });
        } else {
          setValidation({
            kind: "error",
            message: body.error || "This invitation is not valid.",
          });
        }
      })
      .catch(() => {
        setValidation({
          kind: "error",
          message: "Could not validate the invitation. Check your connection and try again.",
        });
      });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    if (password !== confirmPassword) {
      setSubmitError("Passwords do not match.");
      return;
    }
    if (password.length < 8) {
      setSubmitError("Password must be at least 8 characters.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/auth/registration-invites/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invite, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError(body.error || "Activation failed. Please try again.");
        // If the invite is no longer valid OR the email has been claimed in the
        // meantime (409), there's no recovery from this form — flip to the
        // terminal "Invitation Unavailable" card so the user is sent back to
        // /apply or /login instead of retrying a password they can never set.
        if (res.status === 410 || res.status === 404 || res.status === 409) {
          setValidation({ kind: "error", message: body.error || "This invitation is no longer valid." });
        }
        return;
      }
      // Seed auth state from the server-issued JWT and route by role.
      loginWithJwt(body.token, body.user);
      const role = body.user.role;
      if (role === "adviser") {
        navigate("/adviser/dashboard", { replace: true });
      } else if (role === "admin") {
        navigate("/admin", { replace: true });
      } else {
        navigate("/dashboard", { replace: true });
      }
    } catch {
      setSubmitError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // ---- Loading state -------------------------------------------------------
  if (validation.kind === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md">
          <CardContent className="py-10 flex flex-col items-center gap-3">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Checking your invitation…</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---- Invalid / expired / used invite -------------------------------------
  if (validation.kind === "error") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <CardTitle>Invitation Unavailable</CardTitle>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Alert variant="destructive">
              <AlertDescription>{validation.message}</AlertDescription>
            </Alert>
            <div className="text-sm text-muted-foreground">
              Invitations expire after 48 hours and can only be used once. Ask your administrator
              to issue a new one, or apply for an account if you don't have an invitation yet.
            </div>
            <div className="flex flex-col gap-2">
              <Link href="/apply">
                <Button variant="outline" className="w-full" data-testid="link-apply">
                  Apply for an account
                </Button>
              </Link>
              <Link href="/login">
                <Button variant="ghost" className="w-full" data-testid="link-login">
                  Back to sign in
                </Button>
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ---- Valid invite — render the activation form ---------------------------
  const { invite: details } = validation;
  const expiry = new Date(details.expiresAt);
  const hoursLeft = Math.max(0, Math.round((expiry.getTime() - Date.now()) / (60 * 60 * 1000)));

  return (
    <div className="min-h-screen flex items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-primary" />
            <CardTitle>AMAX Wealth Account Activation</CardTitle>
          </div>
          <CardDescription>
            You've been invited to create an AMAX Wealth account. Set a password below
            to activate it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="rounded-lg border bg-card/50 p-3 mb-5 space-y-1.5 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Email</span>
              <span className="font-medium" data-testid="text-invite-email">{details.email}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Role</span>
              <Badge variant="secondary" data-testid="badge-invite-role">
                {ROLE_LABEL[details.role] ?? details.role}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Link expires in</span>
              <span className="text-xs text-muted-foreground">
                ~{hoursLeft} {hoursLeft === 1 ? "hour" : "hours"}
              </span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label htmlFor="password">Set password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                data-testid="input-password"
              />
              <p className="text-xs text-muted-foreground mt-1">
                At least 8 characters.
              </p>
            </div>
            <div>
              <Label htmlFor="confirmPassword">Confirm password</Label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                autoComplete="new-password"
                data-testid="input-confirm-password"
              />
            </div>

            {submitError && (
              <Alert variant="destructive">
                <AlertDescription data-testid="text-submit-error">{submitError}</AlertDescription>
              </Alert>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={submitting}
              data-testid="button-activate-account"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Activating account…
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                  Activate account
                </>
              )}
            </Button>

            <p className="text-xs text-muted-foreground text-center pt-2">
              By activating, you agree to our{" "}
              <Link href="/legal" className="underline">terms and disclosures</Link>.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
