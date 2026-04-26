import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Mail, Send, Copy, Check, Info, Clock } from "lucide-react";

// -----------------------------------------------------------------------------
// /admin/registration-invites
//
// Issues a one-time registration invite directly (without going through the
// public /apply form). The backend already exists at:
//   POST /api/admin/registration-invites { email, role, adviserUserId? }
// returning { email, role, inviteLink, expiresAt }.
//
// Hard rules surfaced in the UI:
//   - The raw inviteLink is shown ONCE in a modal after issuance and never
//     stored or re-emitted by the API. If the admin closes the dialog without
//     copying it, they must reissue.
//   - role=adviser (and admin) is gated to admin-issued invites only — that
//     gate lives on the server; this UI just exposes the choice.
//   - role=client + adviserUserId auto-creates the adviserClients link at
//     activation (server-side, inside the activation transaction).
//
// We deliberately do NOT add a "list active invites" view here yet — the
// audit-log page already shows registration_invite_created events with full
// metadata. A dedicated active-invite list belongs in a later session.
// -----------------------------------------------------------------------------

interface AdviserOpt {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
}

const formSchema = z
  .object({
    email: z.string().email("Enter a valid email address"),
    role: z.enum(["client", "adviser", "admin"]),
    adviserUserId: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (val.role !== "client" && val.adviserUserId && val.adviserUserId !== "none") {
      ctx.addIssue({
        path: ["adviserUserId"],
        code: "custom",
        message: "Adviser link only applies when role is 'client'",
      });
    }
  });

type FormValues = z.infer<typeof formSchema>;

interface IssuedInvite {
  email: string;
  role: string;
  inviteLink: string;
  expiresAt: string;
}

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export default function AdminRegistrationInvites() {
  const { toast } = useToast();
  const [issued, setIssued] = useState<IssuedInvite | null>(null);
  const [copied, setCopied] = useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { email: "", role: "client", adviserUserId: "none" },
  });

  const role = form.watch("role");

  // When the admin switches role away from client, force-reset the adviser
  // dropdown so the form value can never contradict the server's
  // "adviserUserId only valid when role=client" check.
  useEffect(() => {
    if (role !== "client") {
      form.setValue("adviserUserId", "none");
    }
  }, [role, form]);

  const { data: advisers } = useQuery<AdviserOpt[]>({
    queryKey: ["/api/admin/advisers"],
  });

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const body: Record<string, unknown> = {
        email: values.email.trim().toLowerCase(),
        role: values.role,
      };
      if (
        values.role === "client" &&
        values.adviserUserId &&
        values.adviserUserId !== "none"
      ) {
        body.adviserUserId = Number(values.adviserUserId);
      }
      const res = await apiRequest("POST", "/api/admin/registration-invites", body);
      return res.json() as Promise<IssuedInvite>;
    },
    onSuccess: (data) => {
      setIssued(data);
      setCopied(false);
      form.reset({ email: "", role: "client", adviserUserId: "none" });
      // Audit log will reflect the new invite — refresh anywhere it's listed.
      queryClient.invalidateQueries({ queryKey: ["/api/admin/audit-logs"] });
      toast({
        title: "Invitation issued",
        description: "Copy the link before closing — it is shown only once.",
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Could not issue invite",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  function onSubmit(values: FormValues) {
    mutation.mutate(values);
  }

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Registration invites</h1>
        <p className="text-sm text-slate-500 mt-1">
          Issue a one-time registration link directly to a new user. Use this
          when you want to add someone without them going through the public
          application form.
        </p>
      </div>

      <Alert className="border-violet-200 bg-violet-50 text-violet-900">
        <Info className="h-4 w-4 text-violet-700" />
        <AlertTitle className="text-violet-900">One-time link, 48-hour expiry</AlertTitle>
        <AlertDescription className="text-violet-800">
          The invite link is shown only once on the next screen. Copy it before
          closing — the system never stores the raw link and cannot recover it.
          Re-issuing for the same email automatically revokes any prior live
          invite.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Send className="h-4 w-4 text-slate-600" />
            Issue invitation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-4"
              data-testid="form-issue-invite"
            >
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email address</FormLabel>
                    <FormControl>
                      <Input
                        type="email"
                        placeholder="someone@example.com"
                        autoComplete="off"
                        data-testid="input-email"
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>
                      The email becomes the user's username on activation.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Role</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-role">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="client">Client</SelectItem>
                        <SelectItem value="adviser">Adviser (AR)</SelectItem>
                        <SelectItem value="admin">Admin</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      {role === "adviser" &&
                        "Advisers can only be onboarded by direct admin invite — never via the public form."}
                      {role === "admin" &&
                        "Admin invites grant full back-office access. Issue with extreme care."}
                      {role === "client" &&
                        "Optionally link the new client to an existing adviser below."}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {role === "client" && (
                <FormField
                  control={form.control}
                  name="adviserUserId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Link to adviser (optional)</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? "none"}>
                        <FormControl>
                          <SelectTrigger data-testid="select-adviser">
                            <SelectValue placeholder="No adviser link" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="none">No adviser link</SelectItem>
                          {(advisers ?? []).map((a) => (
                            <SelectItem key={a.id} value={String(a.id)}>
                              {a.firstName} {a.lastName} — @{a.username}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormDescription>
                        If selected, an active adviser-client link is created
                        automatically when the client activates the invite.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button
                  type="submit"
                  disabled={mutation.isPending}
                  data-testid="button-issue"
                >
                  {mutation.isPending ? (
                    "Issuing…"
                  ) : (
                    <>
                      <Mail className="h-4 w-4 mr-2" />
                      Issue invitation
                    </>
                  )}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      <Dialog
        open={!!issued}
        onOpenChange={(o) => {
          if (!o) {
            setIssued(null);
            setCopied(false);
          }
        }}
      >
        <DialogContent data-testid="dialog-issued-invite">
          <DialogHeader>
            <DialogTitle>Invitation ready</DialogTitle>
            <DialogDescription>
              Share this link with the recipient. It expires{" "}
              {issued && (
                <span className="inline-flex items-center gap-1 font-medium text-slate-900">
                  <Clock className="h-3.5 w-3.5" />
                  {formatExpiry(issued.expiresAt)}
                </span>
              )}{" "}
              and can be used only once.
            </DialogDescription>
          </DialogHeader>

          {issued && (
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                <span className="text-slate-700">{issued.email}</span>
                <Badge variant="outline" className="capitalize">
                  {issued.role}
                </Badge>
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium text-slate-600">Invite link</p>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={issued.inviteLink}
                    className="font-mono text-xs"
                    data-testid="input-invite-link"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(issued.inviteLink);
                        setCopied(true);
                        toast({ title: "Link copied to clipboard" });
                      } catch {
                        toast({
                          title: "Couldn't copy",
                          description: "Select the link manually and copy.",
                          variant: "destructive",
                        });
                      }
                    }}
                    data-testid="button-copy-link"
                  >
                    {copied ? (
                      <>
                        <Check className="h-4 w-4 mr-1" /> Copied
                      </>
                    ) : (
                      <>
                        <Copy className="h-4 w-4 mr-1" /> Copy
                      </>
                    )}
                  </Button>
                </div>
                <p className="text-xs text-slate-500">
                  Re-opening this dialog will not bring the link back. If you
                  lose it, simply re-issue for the same email — that revokes
                  the prior invite.
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIssued(null);
                setCopied(false);
              }}
              data-testid="button-close-dialog"
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
