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
import { Switch } from "@/components/ui/switch";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Plus, Package } from "lucide-react";
import {
  RISK_PROFILE_KEYS,
  RISK_PROFILE_LABELS,
  riskProfileLabel,
  type KnownRiskProfile,
} from "@shared/risk-profiles";

interface InvestmentProduct {
  id: number;
  name: string;
  category: string;
  subCategory: string;
  investmentStrategy: string;
  targetNetIrr: string;
  grossIrr: string | null;
  moic: string | null;
  term: string;
  structure: string;
  distributions: string;
  liquidity: string;
  minimumInvestment: string;
  riskProfile: string;
  returnType: string;
  lvr: string | null;
  annualReturn: string | null;
  returnMethod: string;
  isActive: boolean;
  isPublished: boolean;
  createdAt: string | null;
}

const createProductSchema = z.object({
  name: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  subCategory: z.string().min(1).max(100),
  investmentStrategy: z.string().min(1).max(500),
  targetNetIrr: z.string().min(1).max(50),
  term: z.string().min(1).max(100),
  structure: z.string().min(1).max(200),
  distributions: z.string().min(1).max(200),
  liquidity: z.string().min(1).max(200),
  minimumInvestment: z.string().regex(/^\d+(\.\d{1,2})?$/, "Whole number or decimal e.g. 50000.00"),
  // Sourced from the shared risk-profile list so adding a band only requires
  // editing `shared/risk-profiles.ts`. Cast satisfies z.enum's tuple shape.
  riskProfile: z.enum(RISK_PROFILE_KEYS as [KnownRiskProfile, ...KnownRiskProfile[]]),
  returnType: z.enum(["income", "capital_gains", "blended"]),
  returnMethod: z.enum(["fixed_annual_compound", "fixed_annual_simple"]),
  // Decimal fraction in [0, 1]. Required because portfolio valuation is
  // fail-closed when annualReturn is null and an active catalogue product
  // without it would surface as silent "unknown valuation" downstream.
  // e.g. 0.11 = 11% p.a. Server enforces the same bound authoritatively.
  annualReturn: z
    .string()
    .regex(/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/, "Decimal fraction in [0, 1], up to 4 decimals e.g. 0.11"),
  isActive: z.boolean().default(true),
  // Investor-visibility flag — Task #350. Distinct from isActive: a product
  // can be active (referenced by user_investments, valued nightly) yet still
  // hidden from investor-facing reads while being staged as a draft.
  isPublished: z.boolean().default(true),
});
type CreateProductValues = z.infer<typeof createProductSchema>;

function fmtMoney(s: string): string {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

export default function AdminProducts() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useQuery<InvestmentProduct[]>({ queryKey: ["/api/admin/products"] });

  const form = useForm<CreateProductValues>({
    resolver: zodResolver(createProductSchema),
    defaultValues: {
      name: "",
      category: "",
      subCategory: "",
      investmentStrategy: "",
      targetNetIrr: "",
      term: "",
      structure: "",
      distributions: "",
      liquidity: "",
      minimumInvestment: "",
      riskProfile: "moderate",
      returnType: "blended",
      returnMethod: "fixed_annual_compound",
      annualReturn: "",
      isActive: true,
      isPublished: true,
    },
  });

  const createMut = useMutation({
    mutationFn: async (values: CreateProductValues) => {
      const res = await apiRequest("POST", "/api/admin/products", values);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/products"] });
      toast({ title: "Product created" });
      setOpen(false);
      form.reset();
    },
    onError: (err: Error) => {
      toast({ title: "Create failed", description: err.message, variant: "destructive" });
    },
  });

  const toggleMut = useMutation({
    mutationFn: async (vars: { id: number; isActive: boolean }) => {
      const res = await apiRequest("PATCH", `/api/admin/products/${vars.id}`, {
        isActive: vars.isActive,
      });
      return res.json();
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/products"] });
      toast({
        title: vars.isActive ? "Product activated" : "Product deactivated",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  // Task #350 — investor-visibility toggle. Sent in its own PATCH so it is
  // independent of the active/inactive switch and cleanly audited.
  const togglePublishedMut = useMutation({
    mutationFn: async (vars: { id: number; isPublished: boolean }) => {
      const res = await apiRequest("PATCH", `/api/admin/products/${vars.id}`, {
        isPublished: vars.isPublished,
      });
      return res.json();
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/products"] });
      toast({
        title: vars.isPublished ? "Product published" : "Moved to draft",
      });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-4 max-w-7xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Investment Products</h1>
          <p className="text-sm text-slate-500 mt-1">
            Catalogue of products available to advisers when constructing client portfolios.
          </p>
        </div>
        <Button onClick={() => setOpen(true)} data-testid="button-new-product">
          <Plus className="h-4 w-4 mr-1" />
          New product
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4 text-violet-600" />
            {isLoading ? "Loading…" : `${data?.length ?? 0} product${data?.length === 1 ? "" : "s"}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !data || data.length === 0 ? (
            <p className="text-sm text-slate-500">
              No products yet. Add one to make it available to advisers.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Risk</TableHead>
                  <TableHead>Target IRR</TableHead>
                  <TableHead>Min</TableHead>
                  <TableHead>Term</TableHead>
                  <TableHead>Visibility</TableHead>
                  <TableHead className="text-right">Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((p) => (
                  <TableRow key={p.id} data-testid={`row-product-${p.id}`}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>
                      <div className="text-sm">{p.category}</div>
                      <div className="text-xs text-slate-500">{p.subCategory}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{riskProfileLabel(p.riskProfile)}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">{p.targetNetIrr}</TableCell>
                    <TableCell className="text-sm">{fmtMoney(p.minimumInvestment)}</TableCell>
                    <TableCell className="text-sm">{p.term}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={p.isPublished ? "default" : "secondary"}
                          data-testid={`badge-product-visibility-${p.id}`}
                        >
                          {p.isPublished ? "Published" : "Draft"}
                        </Badge>
                        <Switch
                          checked={p.isPublished}
                          disabled={togglePublishedMut.isPending}
                          onCheckedChange={(v) =>
                            togglePublishedMut.mutate({ id: p.id, isPublished: v })
                          }
                          aria-label="Toggle visible to investors"
                          data-testid={`switch-product-published-${p.id}`}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <Switch
                        checked={p.isActive}
                        disabled={toggleMut.isPending}
                        onCheckedChange={(v) => toggleMut.mutate({ id: p.id, isActive: v })}
                        data-testid={`switch-product-active-${p.id}`}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>New investment product</DialogTitle>
            <DialogDescription>
              Adds the product to the catalogue. Only active products are shown to advisers.
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit((v) => createMut.mutate(v))}
              className="space-y-3 max-h-[70vh] overflow-y-auto pr-1"
            >
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Product name</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-product-name" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="category"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Category</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="real_estate, corporate_credit…"
                          {...field}
                          data-testid="input-product-category"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="subCategory"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Sub-category</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="equity_fund, first_mortgage…"
                          {...field}
                          data-testid="input-product-subcategory"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="investmentStrategy"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Strategy</FormLabel>
                    <FormControl>
                      <Input {...field} data-testid="input-product-strategy" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-3 gap-3">
                <FormField
                  control={form.control}
                  name="targetNetIrr"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Target net IRR</FormLabel>
                      <FormControl>
                        <Input placeholder="8-10%" {...field} data-testid="input-product-irr" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="minimumInvestment"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Minimum (AUD)</FormLabel>
                      <FormControl>
                        <Input placeholder="50000" {...field} data-testid="input-product-minimum" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="term"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Term</FormLabel>
                      <FormControl>
                        <Input placeholder="3 years" {...field} data-testid="input-product-term" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <FormField
                  control={form.control}
                  name="structure"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Structure</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-product-structure" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="distributions"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Distributions</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-product-distributions" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="liquidity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Liquidity</FormLabel>
                      <FormControl>
                        <Input {...field} data-testid="input-product-liquidity" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <FormField
                  control={form.control}
                  name="riskProfile"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Risk profile</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-product-risk">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(RISK_PROFILE_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="returnType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Return type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-product-return-type">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="income">Income</SelectItem>
                          <SelectItem value="capital_gains">Capital gains</SelectItem>
                          <SelectItem value="blended">Blended</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="returnMethod"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Return method</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-product-return-method">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="fixed_annual_compound">Fixed annual compound</SelectItem>
                          <SelectItem value="fixed_annual_simple">Fixed annual simple</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="annualReturn"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Annual return (decimal)</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="0.11 means 11% p.a."
                        {...field}
                        data-testid="input-product-annual-return"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="isPublished"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2">
                    <div className="space-y-0.5">
                      <FormLabel className="text-sm">Visible to investors</FormLabel>
                      <p className="text-xs text-slate-500">
                        Off keeps the product as a draft — hidden from investor-facing
                        listings while still available in the admin catalogue.
                      </p>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="switch-product-published"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createMut.isPending} data-testid="button-submit-product">
                  {createMut.isPending ? "Creating…" : "Create product"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
