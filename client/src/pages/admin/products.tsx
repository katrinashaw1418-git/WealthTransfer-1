import { useEffect, useMemo, useState } from "react";
import { useSearch } from "wouter";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
import { Plus, Package, Pencil, History } from "lucide-react";
import {
  RISK_PROFILE_KEYS,
  RISK_PROFILE_LABELS,
  riskProfileLabel,
  type KnownRiskProfile,
} from "@shared/risk-profiles";
import {
  PRODUCT_CATEGORY_VALUES,
  PRODUCT_CATEGORY_LABELS,
  productCategoryLabel,
} from "@shared/product-categories";

export interface InvestmentProduct {
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
  // Constrained to the canonical category enum so the form UI cannot submit a
  // value the server-side validator (Task #341) would reject.
  category: z.enum(PRODUCT_CATEGORY_VALUES),
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

// Default form values used when opening the dialog in "create" mode.
const EMPTY_PRODUCT_VALUES: CreateProductValues = {
  name: "",
  // Default to the first canonical category so the dropdown always renders
  // a valid selection; admin must still pick the right one before saving.
  category: PRODUCT_CATEGORY_VALUES[0],
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
};

// The narrow enum unions used by the form. Kept inline (not exported) so the
// coercion helpers below can do typed `includes` checks without escaping the
// type system via `as any` casts.
const RETURN_TYPE_VALUES = ["income", "capital_gains", "blended"] as const;
type ReturnTypeValue = (typeof RETURN_TYPE_VALUES)[number];
const RETURN_METHOD_VALUES = ["fixed_annual_compound", "fixed_annual_simple"] as const;
type ReturnMethodValue = (typeof RETURN_METHOD_VALUES)[number];
type ProductCategoryValue = (typeof PRODUCT_CATEGORY_VALUES)[number];

function isProductCategory(value: string): value is ProductCategoryValue {
  return (PRODUCT_CATEGORY_VALUES as readonly string[]).includes(value);
}
function isRiskProfile(value: string): value is KnownRiskProfile {
  return (RISK_PROFILE_KEYS as readonly string[]).includes(value);
}
function isReturnType(value: string): value is ReturnTypeValue {
  return (RETURN_TYPE_VALUES as readonly string[]).includes(value);
}
function isReturnMethod(value: string): value is ReturnMethodValue {
  return (RETURN_METHOD_VALUES as readonly string[]).includes(value);
}

// Coerce a server-shaped product row into the form value shape. The form
// schema is strict about category / risk / return enums and treats
// annualReturn as a string, so null becomes "" for the input. The typed
// guards above narrow each enum-ish field without any `as any` escapes.
function productToFormValues(p: InvestmentProduct): CreateProductValues {
  return {
    name: p.name,
    category: isProductCategory(p.category) ? p.category : PRODUCT_CATEGORY_VALUES[0],
    subCategory: p.subCategory,
    investmentStrategy: p.investmentStrategy,
    targetNetIrr: p.targetNetIrr,
    term: p.term,
    structure: p.structure,
    distributions: p.distributions,
    liquidity: p.liquidity,
    minimumInvestment: p.minimumInvestment,
    riskProfile: isRiskProfile(p.riskProfile) ? p.riskProfile : "moderate",
    returnType: isReturnType(p.returnType) ? p.returnType : "blended",
    returnMethod: isReturnMethod(p.returnMethod) ? p.returnMethod : "fixed_annual_compound",
    annualReturn: p.annualReturn ?? "",
    isActive: p.isActive,
    isPublished: p.isPublished,
  };
}

// Task #385 — shape returned by GET /api/admin/products/:id/history. The
// audit-log row's metadata is the same JSON the PATCH handler writes (see
// `admin_product_updated` audit call in `server/admin-routes.ts`); only
// `updatedFields` is rendered today but the full blob is kept here so a
// future "before/after" surface can light up without a server change.
interface ProductHistoryEntry {
  id: number;
  userId: number | null;
  action: string;
  metadata: {
    updatedFields?: string[];
    previousIsActive?: boolean | null;
    newIsActive?: boolean | null;
    previousIsPublished?: boolean | null;
    newIsPublished?: boolean | null;
  } | null;
  createdAt: string | null;
  actorUsername: string | null;
  actorEmail: string | null;
}

function fmtTimestamp(s: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

// Task #358 — visibility filter values for the All / Published / Draft tabs.
// "all" is the default so the page keeps the same shape as before for admins
// who land here without an explicit choice.
const VISIBILITY_FILTERS = ["all", "published", "draft"] as const;
type VisibilityFilter = (typeof VISIBILITY_FILTERS)[number];

function isVisibilityFilter(value: string | null): value is VisibilityFilter {
  return value !== null && (VISIBILITY_FILTERS as readonly string[]).includes(value);
}

export default function AdminProducts() {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  // When set, the dialog is in "edit" mode targeting this product's id.
  // null means the dialog (when open) is creating a new product.
  const [editingId, setEditingId] = useState<number | null>(null);
  // Task #385 — when set, the history dialog is open for this product.
  const [historyForProduct, setHistoryForProduct] = useState<InvestmentProduct | null>(null);
  const { data, isLoading } = useQuery<InvestmentProduct[]>({ queryKey: ["/api/admin/products"] });

  // Task #358 — Draft/Published quick filter. Persisted in the URL
  // (`?visibility=draft|published`) so the choice survives a refresh and is
  // shareable. We hydrate from the querystring on first render only; the page
  // UI is the canonical writer afterwards and pushes back to the URL via
  // history.replaceState (no navigation, no scroll jump).
  const searchString = useSearch();
  const initialVisibility: VisibilityFilter = useMemo(() => {
    const v = new URLSearchParams(searchString).get("visibility");
    return isVisibilityFilter(v) ? v : "all";
    // Intentionally only read on first mount; subsequent URL writes come from
    // this component itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [visibility, setVisibility] = useState<VisibilityFilter>(initialVisibility);

  // Mirror the active filter into the URL so a refresh restores the same
  // view. We use replaceState to avoid polluting browser history with one
  // entry per tab click, and we strip the param entirely for the default
  // ("all") so the URL stays clean when no filter is applied.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (visibility === "all") {
      sp.delete("visibility");
    } else {
      sp.set("visibility", visibility);
    }
    const next = sp.toString();
    const url = `${window.location.pathname}${next ? `?${next}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", url);
  }, [visibility]);

  // Filtered list driving both the table body and the header count so the
  // "N products" label always matches the number of rows actually rendered.
  const filteredProducts = useMemo(() => {
    if (!data) return [];
    if (visibility === "published") return data.filter((p) => p.isPublished);
    if (visibility === "draft") return data.filter((p) => !p.isPublished);
    return data;
  }, [data, visibility]);

  const form = useForm<CreateProductValues>({
    resolver: zodResolver(createProductSchema),
    defaultValues: EMPTY_PRODUCT_VALUES,
  });

  const openCreateDialog = () => {
    setEditingId(null);
    form.reset(EMPTY_PRODUCT_VALUES);
    setOpen(true);
  };

  const openEditDialog = (product: InvestmentProduct) => {
    setEditingId(product.id);
    form.reset(productToFormValues(product));
    setOpen(true);
  };

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setEditingId(null);
      form.reset(EMPTY_PRODUCT_VALUES);
    }
  };

  const createMut = useMutation({
    mutationFn: async (values: CreateProductValues) => {
      const res = await apiRequest("POST", "/api/admin/products", values);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/products"] });
      toast({ title: "Product created" });
      handleOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Create failed", description: err.message, variant: "destructive" });
    },
  });

  // Edit-mode submit. Only the fields the admin actually changed are sent so
  // we don't accidentally rewrite values they never touched (and so the audit
  // log entry on the server reflects the real diff). The PATCH handler
  // already accepts the full editable field set partially.
  const updateMut = useMutation({
    mutationFn: async (vars: { id: number; changes: Partial<CreateProductValues> }) => {
      const res = await apiRequest("PATCH", `/api/admin/products/${vars.id}`, vars.changes);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/admin/products"] });
      toast({ title: "Product updated" });
      handleOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const submitDialog = (values: CreateProductValues) => {
    if (editingId === null) {
      createMut.mutate(values);
      return;
    }
    // Build the patch from react-hook-form's dirtyFields map so we only PATCH
    // fields the admin actually changed. If nothing changed, just close.
    // Each per-key copy is wrapped in a generic helper so the value type is
    // preserved end-to-end and no `as any` escape is needed.
    const dirty = form.formState.dirtyFields as Partial<Record<keyof CreateProductValues, boolean>>;
    const changes: Partial<CreateProductValues> = {};
    function copyIfDirty<K extends keyof CreateProductValues>(key: K) {
      if (dirty[key]) {
        changes[key] = values[key];
      }
    }
    (Object.keys(values) as (keyof CreateProductValues)[]).forEach((key) => copyIfDirty(key));
    if (Object.keys(changes).length === 0) {
      toast({ title: "No changes to save" });
      handleOpenChange(false);
      return;
    }
    updateMut.mutate({ id: editingId, changes });
  };

  const isSubmitting = createMut.isPending || updateMut.isPending;

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
        <Button onClick={openCreateDialog} data-testid="button-new-product">
          <Plus className="h-4 w-4 mr-1" />
          New product
        </Button>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-base flex items-center gap-2">
            <Package className="h-4 w-4 text-violet-600" />
            {isLoading
              ? "Loading…"
              : `${filteredProducts.length} product${filteredProducts.length === 1 ? "" : "s"}`}
          </CardTitle>
          {/* Task #358 — visibility quick filter. Defaults to All; selection is
              persisted to the URL so a refresh restores the same view. */}
          <Tabs
            value={visibility}
            onValueChange={(v) => {
              if (isVisibilityFilter(v)) setVisibility(v);
            }}
          >
            <TabsList data-testid="tabs-product-visibility-filter">
              <TabsTrigger value="all" data-testid="tab-product-visibility-all">
                All
              </TabsTrigger>
              <TabsTrigger value="published" data-testid="tab-product-visibility-published">
                Published
              </TabsTrigger>
              <TabsTrigger value="draft" data-testid="tab-product-visibility-draft">
                Draft
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !data || data.length === 0 ? (
            <p className="text-sm text-slate-500">
              No products yet. Add one to make it available to advisers.
            </p>
          ) : filteredProducts.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="text-no-filtered-products">
              {visibility === "draft"
                ? "No draft products. Every product is currently published."
                : "No published products. Every product is currently a draft."}
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
                  <TableHead className="text-right">Edit</TableHead>
                  <TableHead className="text-right">History</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredProducts.map((p) => (
                  <TableRow key={p.id} data-testid={`row-product-${p.id}`}>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell>
                      <div className="text-sm">{productCategoryLabel(p.category)}</div>
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
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEditDialog(p)}
                        data-testid={`button-edit-product-${p.id}`}
                      >
                        <Pencil className="h-4 w-4 mr-1" />
                        Edit
                      </Button>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setHistoryForProduct(p)}
                        data-testid={`button-history-product-${p.id}`}
                      >
                        <History className="h-4 w-4 mr-1" />
                        History
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle data-testid="text-product-dialog-title">
              {editingId === null ? "New investment product" : "Edit investment product"}
            </DialogTitle>
            <DialogDescription>
              {editingId === null
                ? "Adds the product to the catalogue. Only active products are shown to advisers."
                : "Update the product details. Only fields you change will be saved."}
            </DialogDescription>
          </DialogHeader>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(submitDialog)}
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
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-product-category">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {PRODUCT_CATEGORY_VALUES.map((value) => (
                            <SelectItem key={value} value={value}>
                              {PRODUCT_CATEGORY_LABELS[value]}
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
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting} data-testid="button-submit-product">
                  {editingId === null
                    ? createMut.isPending
                      ? "Creating…"
                      : "Create product"
                    : updateMut.isPending
                      ? "Saving…"
                      : "Save changes"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <ProductHistoryDialog
        product={historyForProduct}
        onOpenChange={(next) => {
          if (!next) setHistoryForProduct(null);
        }}
      />
    </div>
  );
}

// Task #385 — per-product change history dialog. Lazy fetch: the query is
// only enabled when a product is selected (so opening the page doesn't fan
// out one request per row), and cached per product id so re-opening the
// same product is instant.
//
// Exported so a focused component test can lock the URL wiring (the
// default queryFn fetches `queryKey[0]`, so the per-product URL has to be
// the first element of the key, not split across array segments).
export function ProductHistoryDialog({
  product,
  onOpenChange,
}: {
  product: InvestmentProduct | null;
  onOpenChange: (next: boolean) => void;
}) {
  const productId = product?.id ?? null;
  // The default queryFn (see `client/src/lib/queryClient.ts`) fetches
  // `queryKey[0]` as the URL, so the per-product history URL must be the
  // FIRST element of the key, not split across segments — otherwise the
  // dialog would silently re-fetch `/api/admin/products` (the catalogue
  // list) and crash on `data.items.length`.
  const { data, isLoading, isError, error } = useQuery<{ items: ProductHistoryEntry[] }>({
    queryKey: [`/api/admin/products/${productId}/history`],
    enabled: productId !== null,
  });

  return (
    <Dialog open={product !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle data-testid="text-product-history-title">
            Change history{product ? ` — ${product.name}` : ""}
          </DialogTitle>
          <DialogDescription>
            The most recent admin updates to this product. Each entry shows
            who saved the change, when, and which fields they touched.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : isError ? (
            <p className="text-sm text-red-600" data-testid="text-product-history-error">
              Failed to load history: {error instanceof Error ? error.message : "Unknown error"}
            </p>
          ) : !data || data.items.length === 0 ? (
            <p className="text-sm text-slate-500" data-testid="text-product-history-empty">
              No edits recorded for this product yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Fields changed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.items.map((entry) => {
                  const fields = entry.metadata?.updatedFields ?? [];
                  const actor =
                    entry.actorUsername ||
                    entry.actorEmail ||
                    (entry.userId !== null ? `user #${entry.userId}` : "unknown");
                  return (
                    <TableRow
                      key={entry.id}
                      data-testid={`row-product-history-${entry.id}`}
                    >
                      <TableCell className="text-sm whitespace-nowrap">
                        {fmtTimestamp(entry.createdAt)}
                      </TableCell>
                      <TableCell className="text-sm">
                        <div className="font-medium">{actor}</div>
                        {entry.actorUsername && entry.actorEmail ? (
                          <div className="text-xs text-slate-500">{entry.actorEmail}</div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        {fields.length === 0 ? (
                          <span className="text-xs text-slate-500">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {fields.map((f) => (
                              <Badge key={f} variant="secondary" className="text-xs">
                                {f}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
