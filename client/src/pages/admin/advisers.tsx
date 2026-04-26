import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus, Users } from "lucide-react";

interface Adviser {
  id: number;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  createdAt: string | null;
  activeClients: number;
}

const createAdviserSchema = z.object({
  username: z
    .string()
    .min(3, "Min 3 chars")
    .max(50)
    .regex(/^[a-zA-Z0-9_.-]+$/, "Letters, numbers, _, ., - only"),
  email: z.string().email(),
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  password: z.string().min(8, "At least 8 characters"),
});
type CreateAdviserValues = z.infer<typeof createAdviserSchema>;

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return "—";
  }
}

export default function AdminAdvisers() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery<Adviser[]>({ queryKey: ["/api/admin/advisers"] });

  const form = useForm<CreateAdviserValues>({
    resolver: zodResolver(createAdviserSchema),
    defaultValues: { username: "", email: "", firstName: "", lastName: "", password: "" },
  });

  const mutation = useMutation({
    mutationFn: async (values: CreateAdviserValues) => {
      const res = await apiRequest("POST", "/api/admin/advisers", values);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/advisers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/dashboard"] });
      toast({ title: "Adviser created", description: "They can now sign in with their new credentials." });
      setOpen(false);
      form.reset();
    },
    onError: (err: Error) => {
      toast({ title: "Create failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-4 max-w-7xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Advisers</h1>
          <p className="text-sm text-slate-500 mt-1">
            Authorised representatives operating under AMAX Wealth's AFSL.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} data-testid="button-new-adviser">
          <Plus className="h-4 w-4 mr-1" />
          New adviser
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-violet-600" />
            {isLoading ? "Loading…" : `${data?.length ?? 0} adviser${data?.length === 1 ? "" : "s"}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !data || data.length === 0 ? (
            <p className="text-sm text-slate-500">No advisers yet. Create the first one above.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Active clients</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((a) => (
                  <TableRow key={a.id} data-testid={`row-adviser-${a.id}`}>
                    <TableCell className="font-mono text-sm">{a.username}</TableCell>
                    <TableCell>
                      {a.firstName} {a.lastName}
                    </TableCell>
                    <TableCell className="text-sm text-slate-600">{a.email}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{a.activeClients}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{fmt(a.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create new adviser</DialogTitle>
            <DialogDescription>
              The new user will be able to sign in immediately. Share the temporary password securely.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit((v) => mutation.mutate(v))} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="firstName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>First name</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-first-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="lastName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Last name</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-last-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="username"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Username</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-username" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" {...field} data-testid="input-email" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Temporary password</FormLabel>
                    <FormControl>
                      <Input type="password" {...field} data-testid="input-password" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={mutation.isPending} data-testid="button-submit-adviser">
                  {mutation.isPending ? "Creating…" : "Create adviser"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
