import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Plus, Link2 } from "lucide-react";

interface Link {
  id: number;
  adviserUserId: number;
  clientUserId: number;
  relationshipType: string;
  isActive: boolean;
  linkedAt: string | null;
  unlinkedAt: string | null;
  adviserUsername: string;
  adviserEmail: string;
  clientUsername: string;
  clientEmail: string;
  clientFirstName: string;
  clientLastName: string;
}

interface AdviserOpt {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
  activeClients: number;
}

interface ClientOpt {
  id: number;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
}

function fmt(d: string | null): string {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return "—";
  }
}

export default function AdminAdviserClients() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [adviserId, setAdviserId] = useState<string>("");
  const [clientId, setClientId] = useState<string>("");
  const [relationshipType, setRelationshipType] = useState<string>("servicing");

  const { data: links, isLoading } = useQuery<Link[]>({ queryKey: ["/api/admin/adviser-clients"] });
  const { data: advisers } = useQuery<AdviserOpt[]>({ queryKey: ["/api/admin/advisers"] });
  const { data: clients } = useQuery<ClientOpt[]>({ queryKey: ["/api/admin/clients"] });

  const createMutation = useMutation({
    mutationFn: async (vars: { adviserUserId: number; clientUserId: number; relationshipType: string }) => {
      const res = await apiRequest("POST", "/api/admin/adviser-clients", vars);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/adviser-clients"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/advisers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/dashboard"] });
      toast({ title: "Link created" });
      setOpen(false);
      setAdviserId("");
      setClientId("");
      setRelationshipType("servicing");
    },
    onError: (err: Error) => {
      toast({ title: "Link failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async (vars: { id: number; isActive: boolean }) => {
      const res = await apiRequest("PATCH", `/api/admin/adviser-clients/${vars.id}`, { isActive: vars.isActive });
      return res.json();
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/adviser-clients"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/advisers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/admin/dashboard"] });
      toast({ title: vars.isActive ? "Link reactivated" : "Link deactivated" });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  function submit() {
    const a = Number(adviserId);
    const c = Number(clientId);
    if (!a || !c) {
      toast({ title: "Select an adviser and a client", variant: "destructive" });
      return;
    }
    createMutation.mutate({ adviserUserId: a, clientUserId: c, relationshipType });
  }

  const sortedLinks = useMemo(() => {
    if (!links) return [];
    return [...links].sort((x, y) => {
      if (x.isActive !== y.isActive) return x.isActive ? -1 : 1;
      return new Date(y.linkedAt ?? 0).getTime() - new Date(x.linkedAt ?? 0).getTime();
    });
  }, [links]);

  return (
    <div className="space-y-4 max-w-7xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Adviser-client links</h1>
          <p className="text-sm text-slate-500 mt-1">
            Assign clients to advisers. Deactivating a link immediately revokes the adviser's access (including historical reports).
          </p>
        </div>
        <Button onClick={() => setOpen(true)} data-testid="button-new-link">
          <Plus className="h-4 w-4 mr-1" />
          Assign client
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Link2 className="h-4 w-4 text-violet-600" />
            {isLoading ? "Loading…" : `${links?.length ?? 0} link${links?.length === 1 ? "" : "s"}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : sortedLinks.length === 0 ? (
            <p className="text-sm text-slate-500">No adviser-client links yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Adviser</TableHead>
                  <TableHead>Client</TableHead>
                  <TableHead>Relationship</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Linked</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sortedLinks.map((l) => (
                  <TableRow key={l.id} data-testid={`row-link-${l.id}`}>
                    <TableCell>
                      <div className="font-mono text-sm">{l.adviserUsername}</div>
                      <div className="text-xs text-slate-500">{l.adviserEmail}</div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">
                        {l.clientFirstName} {l.clientLastName}
                      </div>
                      <div className="text-xs text-slate-500">{l.clientEmail}</div>
                    </TableCell>
                    <TableCell className="text-sm capitalize">
                      {l.relationshipType.replace(/_/g, " ")}
                    </TableCell>
                    <TableCell>
                      {l.isActive ? (
                        <Badge variant="outline" className="bg-emerald-100 text-emerald-800 border-transparent">
                          Active
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-slate-200 text-slate-700 border-transparent">
                          Inactive
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">{fmt(l.linkedAt)}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => toggleMutation.mutate({ id: l.id, isActive: !l.isActive })}
                        disabled={toggleMutation.isPending}
                        data-testid={`button-toggle-${l.id}`}
                      >
                        {l.isActive ? "Deactivate" : "Reactivate"}
                      </Button>
                    </TableCell>
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
            <DialogTitle>Assign client to adviser</DialogTitle>
            <DialogDescription>
              If a link already exists for this pair, it will be reactivated rather than duplicated.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-sm font-medium text-slate-700">Adviser</label>
              <Select value={adviserId} onValueChange={setAdviserId}>
                <SelectTrigger data-testid="select-adviser">
                  <SelectValue placeholder="Select adviser…" />
                </SelectTrigger>
                <SelectContent>
                  {(advisers ?? []).map((a) => (
                    <SelectItem key={a.id} value={String(a.id)}>
                      {a.username} — {a.firstName} {a.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">Client</label>
              <Select value={clientId} onValueChange={setClientId}>
                <SelectTrigger data-testid="select-client">
                  <SelectValue placeholder="Select client…" />
                </SelectTrigger>
                <SelectContent>
                  {(clients ?? []).map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.username} — {c.firstName} {c.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-700">Relationship</label>
              <Select value={relationshipType} onValueChange={setRelationshipType}>
                <SelectTrigger data-testid="select-relationship">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="servicing">Servicing</SelectItem>
                  <SelectItem value="introducing">Introducing</SelectItem>
                  <SelectItem value="review_only">Review only</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={createMutation.isPending} data-testid="button-confirm-link">
              {createMutation.isPending ? "Linking…" : "Create link"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
