import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  queryClient,
  apiFetch,
  apiRequest,
  apiUpload,
  ApiUploadError,
} from "@/lib/queryClient";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  FormDescription,
} from "@/components/ui/form";
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
  Target,
  FileUp,
  StickyNote,
  Plus,
  Pencil,
  CornerUpRight,
  FileText,
  AlertCircle,
  Lock,
  ShieldAlert,
  Trash2,
  Download,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useToast } from "@/hooks/use-toast";

// Task #318 — policy text quoted on every documents surface so the regulator
// disclosure stays synchronised with the server-side enforcement (the DELETE
// route returns 423 with the same wording in `extra.policy`).
const RETENTION_POLICY_TEXT =
  "Documents are retained for 7 years from creation per Corporations Act s912G. Deletion is locked while the retention window is active.";

function formatRetentionUntil(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString("en-AU", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function isRetentionActive(retentionUntil: string | null | undefined): boolean {
  if (!retentionUntil) return false;
  const t = new Date(retentionUntil).getTime();
  if (!Number.isFinite(t)) return false;
  return t > Date.now();
}

// =============================================================================
// Task #107 — Lock indicator UI for advisers
// =============================================================================
// Whenever an advice record is `status='review_pending'`, the server-side
// gate (server/services/advice-write-gate.ts) blocks adviser writes into its
// children (objectives, pinned documents) with a 423. Before this task,
// advisers had no visual cue and only learned about the lock when their
// submit failed. These helpers surface the lock status everywhere the
// adviser sees an advice record:
//
//   - `AdviceStatusBadge` renders a destructive badge with a Lock icon for
//     review_pending records and falls through to a neutral outline badge
//     for everything else. It is exported for reuse in client-detail.tsx.
//   - `isAdviceRecordLocked` is the single source of truth for the lock
//     condition so callers don't open-code the string comparison.
//   - `LockedRecordWarning` is the inline alert shown inside dialogs when
//     the adviser has selected a locked record — it explains what's
//     happening and why the submit is disabled.
// =============================================================================

export const REVIEW_PENDING_STATUS = "review_pending";

export function isAdviceRecordLocked(
  status: string | null | undefined,
): boolean {
  return status === REVIEW_PENDING_STATUS;
}

export function AdviceStatusBadge({ status }: { status: string }) {
  if (isAdviceRecordLocked(status)) {
    return (
      <Badge
        variant="destructive"
        className="capitalize flex items-center gap-1 w-fit"
        data-testid={`badge-advice-status-${status}`}
        title="This record is under compliance review — adviser writes are blocked"
      >
        <Lock className="h-3 w-3" />
        Under review
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="capitalize"
      data-testid={`badge-advice-status-${status}`}
    >
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

function LockedRecordWarning({ adviceRecordId }: { adviceRecordId: number }) {
  return (
    <div
      className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 flex items-start gap-2"
      data-testid={`warning-locked-advice-${adviceRecordId}`}
      role="alert"
    >
      <Lock className="h-4 w-4 mt-0.5 flex-shrink-0" />
      <div>
        <div className="font-medium">
          Advice record #{adviceRecordId} is under compliance review
        </div>
        <p className="text-xs mt-1">
          Adviser writes are blocked until compliance lifts the lock. Pick a
          different record, or wait for the review to be resolved.
        </p>
      </div>
    </div>
  );
}

const OBJECTIVE_TYPES = [
  "retirement",
  "education",
  "property",
  "estate",
  "income",
  "other",
] as const;
const OBJECTIVE_PRIORITIES = ["primary", "secondary"] as const;
const CLIENT_DOCUMENT_TYPES = [
  "fact_find",
  "risk_questionnaire",
  "id_proof",
  "correspondence",
  "statement",
  "other",
] as const;

interface ClientObjective {
  id: number;
  clientId: number;
  adviceRecordId: number;
  objectiveType: string;
  label: string;
  targetAmount: string | null;
  targetCurrency: string;
  targetDate: string | null;
  priority: string;
  notes: string | null;
  createdByUserId: number;
  createdAt: string | null;
}

interface ClientDocument {
  id: number;
  clientId: number;
  adviceRecordId: number | null;
  documentType: string;
  fileName: string;
  storageKey: string;
  mimeType: string | null;
  fileSizeBytes: number | null;
  description: string | null;
  uploadedByUserId: number;
  uploadedAt: string | null;
  // Task #318 — retention surfacing. The schema already populates these
  // fields (defaults: deletionLocked=true, retentionUntil=now()) so the UI
  // can render the lock chip + "retention until" column today even though
  // the now()+7y trigger is still a future migration.
  retentionUntil: string | null;
  deletionLocked: boolean;
}

interface AdviserNote {
  id: number;
  adviserUserId: number;
  clientUserId: number;
  adviceRecordId: number | null;
  previousNoteId: number | null;
  body: string;
  createdAt: string | null;
}

interface AdviceRecordOption {
  id: number;
  adviceType: string;
  status: string;
  createdAt: string | null;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString("en-AU", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("en-AU", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function formatBytes(n: number | null): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// Task #383 — fire the adviser-side download route, save the streamed bytes
// locally using the original filename. The server already sets
// `Content-Disposition: attachment; filename="..."` but anchor downloads
// are flakier across browsers than driving the filename ourselves with the
// row metadata we already have in cache. apiFetch handles auth + 401
// redirect + non-OK rejection (which we translate into a friendly toast).
async function downloadAdviserClientDocument(
  documentId: number,
  fileName: string,
): Promise<void> {
  const res = await apiFetch(
    `/api/adviser/client-documents/${documentId}/download`,
  );
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName || "document";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Release the object URL on the next tick so the browser has time to
    // start the actual download before we revoke the underlying blob.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

// Translate the `${status}: ${body}` Error apiFetch throws into something
// readable for a toast. The body is usually a JSON envelope like
// `{"error":"Document not found"}` so we try to pull the inner message out;
// otherwise we fall back to the raw error message.
function explainAdviserDownloadError(err: unknown): {
  title: string;
  description: string;
} {
  const raw = err instanceof Error ? err.message : "Unexpected error";
  const match = raw.match(/^(\d+):\s*(.+)$/);
  let status: number | null = null;
  let body = raw;
  if (match) {
    status = Number(match[1]);
    body = match[2];
  }
  let inner = body;
  try {
    const parsed: unknown = JSON.parse(body);
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
    ) {
      inner = (parsed as { error: string }).error;
    }
  } catch {
    // body wasn't JSON — keep as-is
  }
  if (status === 404) {
    return { title: "Document not available", description: inner };
  }
  if (status === 403) {
    return { title: "Not allowed", description: inner };
  }
  return { title: "Could not download document", description: inner };
}

// =============================================================================
// Objective form (create only — objectives are immutable in the API surface)
// =============================================================================

const objectiveFormSchema = z.object({
  adviceRecordId: z
    .string()
    .min(1, "Pick an advice record"),
  objectiveType: z.enum(OBJECTIVE_TYPES),
  label: z.string().min(1, "Label is required").max(500),
  priority: z.enum(OBJECTIVE_PRIORITIES),
  targetAmount: z.string().optional(),
  targetCurrency: z
    .string()
    .length(3, "Use a 3-letter ISO currency code")
    .toUpperCase()
    .optional()
    .or(z.literal("")),
  targetDate: z.string().optional(),
  notes: z.string().max(5000).optional(),
});
type ObjectiveForm = z.infer<typeof objectiveFormSchema>;

function ObjectiveDialog({
  open,
  onOpenChange,
  clientId,
  adviceRecords,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: number;
  adviceRecords: AdviceRecordOption[];
}) {
  const { toast } = useToast();
  const form = useForm<ObjectiveForm>({
    resolver: zodResolver(objectiveFormSchema),
    defaultValues: {
      adviceRecordId: adviceRecords[0]?.id ? String(adviceRecords[0].id) : "",
      objectiveType: "retirement",
      label: "",
      priority: "primary",
      targetAmount: "",
      targetCurrency: "AUD",
      targetDate: "",
      notes: "",
    },
  });

  // Task #107 — watch the selected advice record so we can render the lock
  // banner and disable the submit button without waiting for the server 423.
  const selectedAdviceRecordIdStr = form.watch("adviceRecordId");
  const selectedAdviceRecord = selectedAdviceRecordIdStr
    ? adviceRecords.find((ar) => String(ar.id) === selectedAdviceRecordIdStr)
    : undefined;
  const selectedRecordLocked = isAdviceRecordLocked(
    selectedAdviceRecord?.status,
  );

  const create = useMutation({
    mutationFn: async (values: ObjectiveForm) => {
      const payload: Record<string, unknown> = {
        clientId,
        adviceRecordId: Number(values.adviceRecordId),
        objectiveType: values.objectiveType,
        label: values.label,
        priority: values.priority,
        targetCurrency: (values.targetCurrency || "AUD").toUpperCase(),
      };
      if (values.targetAmount && values.targetAmount.trim() !== "") {
        // The API expects a decimal string; pass through after trimming.
        payload.targetAmount = values.targetAmount.trim();
      }
      if (values.targetDate && values.targetDate.trim() !== "") {
        payload.targetDate = new Date(values.targetDate).toISOString();
      }
      if (values.notes && values.notes.trim() !== "") {
        payload.notes = values.notes;
      }
      const res = await apiRequest("POST", "/api/adviser/client-objectives", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/adviser/client-objectives", clientId],
      });
      toast({ title: "Objective added" });
      onOpenChange(false);
      form.reset();
    },
    onError: (err: any) => {
      toast({
        title: "Could not add objective",
        description: String(err?.message ?? "Unexpected error"),
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-add-objective">
        <DialogHeader>
          <DialogTitle>Add an objective</DialogTitle>
          <DialogDescription>
            Structured objectives replace the free-text summary on the advice
            record.
          </DialogDescription>
        </DialogHeader>
        {adviceRecords.length === 0 ? (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            This client has no advice records yet. Create an advice record before
            adding objectives.
          </div>
        ) : (
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit((v) => create.mutate(v))}
              className="space-y-4"
            >
              <FormField
                control={form.control}
                name="adviceRecordId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Advice record</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-objective-advice">
                          <SelectValue placeholder="Pick an advice record" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {adviceRecords.map((ar) => {
                          const locked = isAdviceRecordLocked(ar.status);
                          return (
                            <SelectItem
                              key={ar.id}
                              value={String(ar.id)}
                              data-testid={`option-objective-advice-${ar.id}`}
                            >
                              <span className="inline-flex items-center gap-2">
                                {locked ? (
                                  <Lock
                                    className="h-3 w-3 text-red-600"
                                    aria-label="Under compliance review"
                                  />
                                ) : null}
                                <span>
                                  #{ar.id} · {ar.adviceType.replace(/_/g, " ")} ·{" "}
                                  {locked ? "under review" : ar.status}
                                </span>
                              </span>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {selectedRecordLocked && selectedAdviceRecord ? (
                <LockedRecordWarning
                  adviceRecordId={selectedAdviceRecord.id}
                />
              ) : null}
              <div className="grid grid-cols-2 gap-3">
                <FormField
                  control={form.control}
                  name="objectiveType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-objective-type">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {OBJECTIVE_TYPES.map((t) => (
                            <SelectItem key={t} value={t} className="capitalize">
                              {t}
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
                  name="priority"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Priority</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger data-testid="select-objective-priority">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {OBJECTIVE_PRIORITIES.map((p) => (
                            <SelectItem key={p} value={p} className="capitalize">
                              {p}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="label"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Label</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. Kids' uni fund"
                        data-testid="input-objective-label"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="grid grid-cols-3 gap-3">
                <FormField
                  control={form.control}
                  name="targetAmount"
                  render={({ field }) => (
                    <FormItem className="col-span-2">
                      <FormLabel>Target amount</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="Optional"
                          inputMode="decimal"
                          data-testid="input-objective-amount"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="targetCurrency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Currency</FormLabel>
                      <FormControl>
                        <Input
                          maxLength={3}
                          data-testid="input-objective-currency"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="targetDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Target date</FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        data-testid="input-objective-date"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        data-testid="input-objective-notes"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={create.isPending || selectedRecordLocked}
                  data-testid="button-submit-objective"
                  title={
                    selectedRecordLocked
                      ? "This advice record is under compliance review — adviser writes are blocked"
                      : undefined
                  }
                >
                  {create.isPending
                    ? "Saving…"
                    : selectedRecordLocked
                      ? "Locked — under review"
                      : "Save objective"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        )}
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// Document upload form
// =============================================================================

// Task #115 — the dialog now performs a real multipart upload to
// `POST /api/adviser/client-documents/upload`. The server computes the
// storageKey, byte length and detected mime type itself (the legacy JSON
// route that took a hand-typed storageKey is no longer used here), so the
// schema only carries the metadata fields the route accepts:
//   - clientId (injected from the panel props)
//   - documentType (required enum)
//   - adviceRecordId (optional — "none" means unpinned)
//   - description (optional)
// The file itself lives in component state because react-hook-form's
// register() doesn't play nicely with file inputs across browsers.
const documentFormSchema = z.object({
  documentType: z.enum(CLIENT_DOCUMENT_TYPES),
  adviceRecordId: z.string().optional(),
  description: z.string().max(2000).optional(),
});
type DocumentForm = z.infer<typeof documentFormSchema>;

// File-picker hint that mirrors the server's default allow-list in
// server/services/upload-security.ts. The `accept` attribute is only a
// hint — the server still enforces the real allow-list and rejects
// anything outside it with UPLOAD_MIME_REJECTED / UPLOAD_MIME_MISMATCH.
const UPLOAD_ACCEPT_HINT = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/tiff",
  "text/plain",
  "text/csv",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
].join(",");

// Task #115 — translate the structured upload error codes
// (server/services/upload-security.ts + advice-write-gate.ts) into toast
// titles a non-technical adviser can act on. Anything we don't recognise
// falls through to a generic "Could not upload document" with the raw
// server message as the description so we never swallow a real error.
function explainUploadError(err: unknown): {
  title: string;
  description: string;
} {
  if (err instanceof ApiUploadError) {
    const description = err.message || "Unexpected error";
    switch (err.code) {
      case "UPLOAD_TOO_LARGE":
        return { title: "File is too large", description };
      case "UPLOAD_MIME_REJECTED":
        return { title: "File type is not allowed", description };
      case "UPLOAD_MIME_MISMATCH":
        return {
          title: "File contents don't match the file type",
          description,
        };
      case "UPLOAD_REJECTED":
        return { title: "Upload was rejected", description };
      default:
        if (err.status === 423) {
          return {
            title: "Advice record is under review",
            description,
          };
        }
        return { title: "Could not upload document", description };
    }
  }
  const description =
    err instanceof Error ? err.message : "Unexpected error";
  return { title: "Could not upload document", description };
}

function DocumentDialog({
  open,
  onOpenChange,
  clientId,
  adviceRecords,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientId: number;
  adviceRecords: AdviceRecordOption[];
}) {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  // Task #380 — track byte-level upload progress so the dialog can render a
  // real progress bar (instead of just a "Uploading…" button label) for
  // large files. `percent === null` means the browser couldn't report a
  // content length and we fall back to an indeterminate-looking bar.
  const [uploadProgress, setUploadProgress] = useState<{
    loaded: number;
    total: number;
    percent: number | null;
  } | null>(null);
  // AbortController for the in-flight XHR. Held in a ref (not state) so
  // closing the dialog mid-upload can synchronously abort without waiting
  // for a re-render.
  const abortControllerRef = useRef<AbortController | null>(null);
  const form = useForm<DocumentForm>({
    resolver: zodResolver(documentFormSchema),
    defaultValues: {
      documentType: "fact_find",
      adviceRecordId: "",
      description: "",
    },
  });

  // Reset transient state every time the dialog opens so a re-opened dialog
  // doesn't show last upload's file, error, or progress bar.
  useEffect(() => {
    if (open) {
      setFile(null);
      setFileError(null);
      setUploadProgress(null);
    }
  }, [open]);

  // Task #107 — same lock-watch pattern as ObjectiveDialog. Documents may be
  // unpinned ("none") in which case the lock never applies.
  const selectedAdviceRecordIdStr = form.watch("adviceRecordId");
  const selectedAdviceRecord =
    selectedAdviceRecordIdStr && selectedAdviceRecordIdStr !== "none"
      ? adviceRecords.find((ar) => String(ar.id) === selectedAdviceRecordIdStr)
      : undefined;
  const selectedRecordLocked = isAdviceRecordLocked(
    selectedAdviceRecord?.status,
  );

  const create = useMutation({
    mutationFn: async (values: DocumentForm) => {
      if (!file) {
        throw new Error("Pick a file to upload");
      }
      const fd = new FormData();
      fd.append("file", file, file.name);
      fd.append("clientId", String(clientId));
      fd.append("documentType", values.documentType);
      if (values.adviceRecordId && values.adviceRecordId !== "none") {
        fd.append("adviceRecordId", values.adviceRecordId);
      }
      if (values.description && values.description.trim() !== "") {
        fd.append("description", values.description.trim());
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;
      // Seed the progress bar at 0% immediately so the bar appears the
      // moment the request starts, before the first onprogress event.
      setUploadProgress({ loaded: 0, total: file.size, percent: 0 });
      try {
        const res = await apiUpload(
          "/api/adviser/client-documents/upload",
          fd,
          {
            signal: controller.signal,
            onProgress: ({ loaded, total, percent }) => {
              setUploadProgress({ loaded, total, percent });
            },
          },
        );
        return await res.json();
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/adviser/client-documents", clientId],
      });
      toast({ title: "Document uploaded" });
      onOpenChange(false);
      form.reset();
      setFile(null);
      setFileError(null);
      setUploadProgress(null);
    },
    onError: (err: unknown) => {
      setUploadProgress(null);
      // Adviser cancelled mid-upload — the dialog has already been closed
      // by handleOpenChange, so a destructive toast would be misleading.
      // A small confirmation toast keeps the action visible without
      // implying the request failed.
      if (err instanceof Error && err.name === "AbortError") {
        toast({ title: "Upload cancelled" });
        return;
      }
      const { title, description } = explainUploadError(err);
      toast({
        title,
        description,
        variant: "destructive",
      });
    },
  });

  const handleSubmit = form.handleSubmit((v) => {
    if (!file) {
      setFileError("Pick a file to upload");
      return;
    }
    setFileError(null);
    create.mutate(v);
  });

  // Wrap the parent-supplied onOpenChange so closing the dialog while an
  // upload is in flight cleanly aborts the XHR (Task #380). Without this,
  // the request would keep streaming bytes after the dialog disappears
  // and the eventual response would be discarded silently.
  const handleOpenChange = (next: boolean) => {
    if (!next && create.isPending) {
      abortControllerRef.current?.abort();
    }
    onOpenChange(next);
  };

  const uploading = create.isPending;
  const progressValue =
    uploadProgress?.percent != null
      ? Math.floor(uploadProgress.percent)
      : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent data-testid="dialog-add-document">
        <DialogHeader>
          <DialogTitle>Upload a document</DialogTitle>
          <DialogDescription>
            Attach a fact-find, ID copy or other client document. The file is
            stored against this client and the original filename is preserved
            for download. SOA / ROA artefacts belong on the advice record, not
            here.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="documentType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger data-testid="select-document-type">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {CLIENT_DOCUMENT_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t.replace(/_/g, " ")}
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
                name="adviceRecordId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Advice record</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value || "none"}
                    >
                      <FormControl>
                        <SelectTrigger data-testid="select-document-advice">
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">Not pinned</SelectItem>
                        {adviceRecords.map((ar) => {
                          const locked = isAdviceRecordLocked(ar.status);
                          return (
                            <SelectItem
                              key={ar.id}
                              value={String(ar.id)}
                              data-testid={`option-document-advice-${ar.id}`}
                            >
                              <span className="inline-flex items-center gap-2">
                                {locked ? (
                                  <Lock
                                    className="h-3 w-3 text-red-600"
                                    aria-label="Under compliance review"
                                  />
                                ) : null}
                                <span>
                                  #{ar.id} ·{" "}
                                  {ar.adviceType.replace(/_/g, " ")}
                                  {locked ? " · under review" : ""}
                                </span>
                              </span>
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                    <FormDescription className="text-xs">
                      Pinning blocks uploads while the record is under review.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {selectedRecordLocked && selectedAdviceRecord ? (
              <LockedRecordWarning
                adviceRecordId={selectedAdviceRecord.id}
              />
            ) : null}
            <FormItem>
              <FormLabel>File</FormLabel>
              <FormControl>
                <Input
                  type="file"
                  accept={UPLOAD_ACCEPT_HINT}
                  data-testid="input-document-file"
                  onChange={(e) => {
                    const next = e.target.files?.[0] ?? null;
                    setFile(next);
                    setFileError(null);
                  }}
                />
              </FormControl>
              <FormDescription className="text-xs">
                {file
                  ? `Selected: ${file.name} (${formatBytes(file.size)})`
                  : "PDF, image, plain text, CSV or Office document. Max 25 MB."}
              </FormDescription>
              {fileError ? (
                <p
                  className="text-sm font-medium text-destructive"
                  data-testid="error-document-file"
                >
                  {fileError}
                </p>
              ) : null}
              {uploading && uploadProgress ? (
                <div
                  className="space-y-1.5 pt-1"
                  data-testid="upload-progress"
                  role="status"
                  aria-live="polite"
                >
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      Uploading{file ? ` ${file.name}` : ""}…
                    </span>
                    <span data-testid="upload-progress-percent">
                      {progressValue != null
                        ? `${progressValue}%`
                        : formatBytes(uploadProgress.loaded)}
                    </span>
                  </div>
                  <Progress
                    value={progressValue ?? 0}
                    data-testid="progress-document-upload"
                    aria-label="Upload progress"
                  />
                  <div className="text-xs text-muted-foreground">
                    {formatBytes(uploadProgress.loaded)}
                    {uploadProgress.total > 0
                      ? ` / ${formatBytes(uploadProgress.total)}`
                      : ""}
                  </div>
                </div>
              ) : null}
            </FormItem>
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={2}
                      placeholder="Optional"
                      data-testid="input-document-description"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => handleOpenChange(false)}
                data-testid="button-cancel-document"
              >
                {uploading ? "Cancel upload" : "Cancel"}
              </Button>
              <Button
                type="submit"
                disabled={uploading || selectedRecordLocked || !file}
                data-testid="button-submit-document"
                title={
                  selectedRecordLocked
                    ? "This advice record is under compliance review — adviser writes are blocked"
                    : !file
                      ? "Pick a file first"
                      : undefined
                }
              >
                {uploading
                  ? progressValue != null
                    ? `Uploading… ${progressValue}%`
                    : "Uploading…"
                  : selectedRecordLocked
                    ? "Locked — under review"
                    : "Upload document"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// Note form (create + amend)
// =============================================================================

const noteFormSchema = z.object({
  body: z.string().min(1, "Note body is required").max(10000),
  adviceRecordId: z.string().optional(),
});
type NoteForm = z.infer<typeof noteFormSchema>;

function NoteDialog({
  open,
  onOpenChange,
  clientUserId,
  adviceRecords,
  amending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clientUserId: number;
  adviceRecords: AdviceRecordOption[];
  amending: AdviserNote | null;
}) {
  const { toast } = useToast();
  const form = useForm<NoteForm>({
    resolver: zodResolver(noteFormSchema),
    defaultValues: {
      body: amending?.body ?? "",
      adviceRecordId: amending?.adviceRecordId
        ? String(amending.adviceRecordId)
        : "",
    },
  });

  // Re-seed defaults when the amend target changes (dialog re-opens for a
  // different note, or for a fresh "add"). Done in an effect rather than
  // during render to avoid feedback loops with react-hook-form's state.
  useEffect(() => {
    if (!open) return;
    form.reset({
      body: amending?.body ?? "",
      adviceRecordId: amending?.adviceRecordId
        ? String(amending.adviceRecordId)
        : "",
    });
    // form is stable from useForm; re-seed only when the dialog opens or the
    // amend target changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, amending?.id]);

  const create = useMutation({
    mutationFn: async (values: NoteForm) => {
      const payload: Record<string, unknown> = {
        clientUserId,
        body: values.body,
      };
      if (values.adviceRecordId && values.adviceRecordId !== "none") {
        payload.adviceRecordId = Number(values.adviceRecordId);
      }
      if (amending) payload.previousNoteId = amending.id;
      const res = await apiRequest("POST", "/api/adviser/client-notes", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/adviser/client-notes", clientUserId],
      });
      toast({
        title: amending ? "Amendment recorded" : "Note added",
        description: amending
          ? "The original note is preserved in the chain."
          : undefined,
      });
      onOpenChange(false);
      form.reset({ body: "", adviceRecordId: "" });
    },
    onError: (err: any) => {
      toast({
        title: "Could not save note",
        description: String(err?.message ?? "Unexpected error"),
        variant: "destructive",
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-add-note">
        <DialogHeader>
          <DialogTitle>
            {amending ? `Amend note #${amending.id}` : "Add a note"}
          </DialogTitle>
          <DialogDescription>
            Notes are append-only. Amendments create a new entry that links back
            to the previous version — nothing is ever overwritten or deleted.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((v) => create.mutate(v))}
            className="space-y-4"
          >
            <FormField
              control={form.control}
              name="adviceRecordId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Advice record</FormLabel>
                  <Select
                    onValueChange={field.onChange}
                    value={field.value || "none"}
                  >
                    <FormControl>
                      <SelectTrigger data-testid="select-note-advice">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">Not pinned</SelectItem>
                      {adviceRecords.map((ar) => (
                        <SelectItem key={ar.id} value={String(ar.id)}>
                          #{ar.id} · {ar.adviceType.replace(/_/g, " ")}
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
              name="body"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note</FormLabel>
                  <FormControl>
                    <Textarea
                      rows={6}
                      data-testid="input-note-body"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={create.isPending}
                data-testid="button-submit-note"
              >
                {create.isPending
                  ? "Saving…"
                  : amending
                    ? "Save amendment"
                    : "Save note"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// Public panel
// =============================================================================

export interface WealthPlannerPanelProps {
  clientId: number;
  adviceRecords: AdviceRecordOption[];
}

export function WealthPlannerPanel({ clientId, adviceRecords }: WealthPlannerPanelProps) {
  const { toast } = useToast();
  const [objectiveOpen, setObjectiveOpen] = useState(false);
  const [documentOpen, setDocumentOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [amending, setAmending] = useState<AdviserNote | null>(null);
  // Task #383 — track which document is currently being downloaded so we can
  // disable just that row's button + swap its label to "Downloading…" without
  // freezing the rest of the table. Only one in-flight download at a time
  // because the underlying anchor click is per-document.
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const handleDownloadDocument = async (doc: ClientDocument) => {
    setDownloadingId(doc.id);
    try {
      await downloadAdviserClientDocument(doc.id, doc.fileName);
    } catch (err) {
      const { title, description } = explainAdviserDownloadError(err);
      toast({ title, description, variant: "destructive" });
    } finally {
      setDownloadingId(null);
    }
  };

  const objectives = useQuery<{ items: ClientObjective[] }>({
    queryKey: ["/api/adviser/client-objectives", clientId],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/adviser/client-objectives?clientId=${clientId}`,
      );
      return res.json();
    },
  });
  const documents = useQuery<{ items: ClientDocument[] }>({
    queryKey: ["/api/adviser/client-documents", clientId],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/adviser/client-documents?clientId=${clientId}`,
      );
      return res.json();
    },
  });
  const notes = useQuery<{ items: AdviserNote[] }>({
    queryKey: ["/api/adviser/client-notes", clientId],
    queryFn: async () => {
      const res = await apiFetch(
        `/api/adviser/client-notes?clientId=${clientId}`,
      );
      return res.json();
    },
  });

  const noteIndex = new Map<number, AdviserNote>();
  (notes.data?.items ?? []).forEach((n) => noteIndex.set(n.id, n));

  return (
    <div className="space-y-4" data-testid="panel-wealth-planner">
      <Tabs defaultValue="objectives" className="space-y-4">
        <TabsList>
          <TabsTrigger value="objectives" data-testid="tab-wp-objectives">
            <Target className="h-4 w-4 mr-2" /> Objectives
          </TabsTrigger>
          <TabsTrigger value="documents" data-testid="tab-wp-documents">
            <FileUp className="h-4 w-4 mr-2" /> Documents
          </TabsTrigger>
          <TabsTrigger value="notes" data-testid="tab-wp-notes">
            <StickyNote className="h-4 w-4 mr-2" /> Notes
          </TabsTrigger>
        </TabsList>

        {/* OBJECTIVES */}
        <TabsContent value="objectives" className="space-y-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Target className="h-4 w-4 text-violet-500" />
                Structured objectives
              </CardTitle>
              <Button
                size="sm"
                onClick={() => setObjectiveOpen(true)}
                data-testid="button-add-objective"
              >
                <Plus className="h-4 w-4 mr-1" />
                Add objective
              </Button>
            </CardHeader>
            <CardContent>
              {objectives.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : objectives.isError ? (
                <p className="text-sm text-red-600">
                  Unable to load objectives.
                </p>
              ) : (objectives.data?.items ?? []).length === 0 ? (
                <p
                  className="text-sm text-gray-500"
                  data-testid="text-no-objectives"
                >
                  No objectives recorded yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Label</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead className="text-right">Target</TableHead>
                      <TableHead>By</TableHead>
                      <TableHead>Advice #</TableHead>
                      <TableHead>Recorded</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(objectives.data?.items ?? []).map((o) => (
                      <TableRow
                        key={o.id}
                        data-testid={`row-objective-${o.id}`}
                      >
                        <TableCell className="text-sm font-medium">
                          {o.label}
                          {o.notes ? (
                            <p className="text-xs text-gray-500 mt-1">
                              {o.notes}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-sm capitalize">
                          {o.objectiveType}
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              o.priority === "primary" ? "default" : "secondary"
                            }
                            className="capitalize"
                          >
                            {o.priority}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-sm tabular-nums text-right">
                          {o.targetAmount
                            ? `${Number(o.targetAmount).toLocaleString("en-AU", {
                                maximumFractionDigits: 2,
                              })} ${o.targetCurrency}`
                            : "—"}
                          {o.targetDate ? (
                            <div className="text-xs text-gray-500">
                              by {formatDate(o.targetDate)}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-sm text-gray-500">
                          #{o.createdByUserId}
                        </TableCell>
                        <TableCell className="text-sm">
                          #{o.adviceRecordId}
                        </TableCell>
                        <TableCell className="text-sm text-gray-500">
                          {formatDate(o.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* DOCUMENTS */}
        <TabsContent value="documents" className="space-y-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <FileText className="h-4 w-4 text-sky-500" />
                Client documents
              </CardTitle>
              <Button
                size="sm"
                onClick={() => setDocumentOpen(true)}
                data-testid="button-add-document"
              >
                <FileUp className="h-4 w-4 mr-1" />
                Upload document
              </Button>
            </CardHeader>
            <CardContent>
              {/* Task #318 — retention policy strip. Surfaces the same s912G
                  policy text that the DELETE route returns inside its 423
                  body, so the adviser sees the rule before they try the
                  Delete button (which is also disabled per row when locked). */}
              <div
                className="rounded-md border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800 mb-3 flex items-start gap-2"
                data-testid="strip-retention-policy"
              >
                <ShieldAlert className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>{RETENTION_POLICY_TEXT}</span>
              </div>
              {documents.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : documents.isError ? (
                <p className="text-sm text-red-600">
                  Unable to load documents.
                </p>
              ) : (documents.data?.items ?? []).length === 0 ? (
                <p
                  className="text-sm text-gray-500"
                  data-testid="text-no-documents"
                >
                  No documents on file.
                </p>
              ) : (
                <TooltipProvider delayDuration={150}>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>File</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Advice #</TableHead>
                        <TableHead>Size</TableHead>
                        <TableHead>Uploaded</TableHead>
                        <TableHead>Retention until</TableHead>
                        <TableHead className="text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(documents.data?.items ?? []).map((d) => {
                        const locked =
                          d.deletionLocked ||
                          isRetentionActive(d.retentionUntil);
                        return (
                          <TableRow
                            key={d.id}
                            data-testid={`row-document-${d.id}`}
                          >
                            <TableCell className="text-sm">
                              <div className="font-medium">{d.fileName}</div>
                              <div className="text-xs text-gray-500">
                                #{d.id}
                              </div>
                              {d.description ? (
                                <div className="text-xs text-gray-500 mt-1">
                                  {d.description}
                                </div>
                              ) : null}
                            </TableCell>
                            <TableCell className="text-sm capitalize">
                              {d.documentType.replace(/_/g, " ")}
                            </TableCell>
                            <TableCell className="text-sm">
                              {d.adviceRecordId ? `#${d.adviceRecordId}` : "—"}
                            </TableCell>
                            <TableCell className="text-sm tabular-nums">
                              {formatBytes(d.fileSizeBytes)}
                            </TableCell>
                            <TableCell className="text-sm text-gray-500">
                              {formatDateTime(d.uploadedAt)}
                            </TableCell>
                            <TableCell className="text-sm">
                              <div className="flex items-center gap-2">
                                <span
                                  className="text-gray-700"
                                  data-testid={`text-retention-until-${d.id}`}
                                >
                                  {formatRetentionUntil(d.retentionUntil)}
                                </span>
                                {locked ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Badge
                                        variant="secondary"
                                        className="flex items-center gap-1 cursor-help"
                                        data-testid={`badge-document-locked-${d.id}`}
                                      >
                                        <Lock className="h-3 w-3" />
                                        Locked
                                      </Badge>
                                    </TooltipTrigger>
                                    <TooltipContent className="max-w-xs">
                                      {RETENTION_POLICY_TEXT}
                                    </TooltipContent>
                                  </Tooltip>
                                ) : null}
                              </div>
                            </TableCell>
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-2">
                                {/* Task #383 — adviser-side download. Mirrors
                                    the per-row Download button on the client
                                    wealth-planner page (client/src/pages/
                                    client/wealth-planner.tsx) and hits the
                                    new GET /api/adviser/client-documents/:id/
                                    download endpoint. The button is always
                                    enabled (retention only restricts deletes,
                                    not reads) and the row-scoped loading
                                    state keeps the rest of the table
                                    interactive. */}
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleDownloadDocument(d)}
                                  disabled={downloadingId === d.id}
                                  data-testid={`button-download-document-${d.id}`}
                                  aria-label={`Download ${d.fileName}`}
                                  title={`Download ${d.fileName}`}
                                >
                                  <Download className="h-4 w-4 mr-1" />
                                  {downloadingId === d.id
                                    ? "Downloading…"
                                    : "Download"}
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={locked}
                                  data-testid={`button-delete-document-${d.id}`}
                                  aria-label={
                                    locked
                                      ? "Delete disabled — document is retained"
                                      : "Delete document"
                                  }
                                  title={
                                    locked ? RETENTION_POLICY_TEXT : "Delete document"
                                  }
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TooltipProvider>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* NOTES */}
        <TabsContent value="notes" className="space-y-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <StickyNote className="h-4 w-4 text-amber-500" />
                Adviser notes
              </CardTitle>
              <Button
                size="sm"
                onClick={() => {
                  setAmending(null);
                  setNoteOpen(true);
                }}
                data-testid="button-add-note"
              >
                <Plus className="h-4 w-4 mr-1" />
                Add note
              </Button>
            </CardHeader>
            <CardContent>
              <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 mb-3 flex items-start gap-2">
                <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>
                  Notes are append-only. Editing a note creates a new entry that
                  links back to the prior version — nothing is overwritten or
                  deleted.
                </span>
              </div>
              {notes.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : notes.isError ? (
                <p className="text-sm text-red-600">Unable to load notes.</p>
              ) : (notes.data?.items ?? []).length === 0 ? (
                <p
                  className="text-sm text-gray-500"
                  data-testid="text-no-notes"
                >
                  No notes recorded yet.
                </p>
              ) : (
                <ol className="space-y-3">
                  {(notes.data?.items ?? []).map((n) => {
                    const prev = n.previousNoteId
                      ? noteIndex.get(n.previousNoteId)
                      : null;
                    return (
                      <li
                        key={n.id}
                        className="rounded-md border border-gray-200 p-3"
                        data-testid={`row-note-${n.id}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 mb-1">
                              <span className="font-mono">#{n.id}</span>
                              <span>·</span>
                              <span>{formatDateTime(n.createdAt)}</span>
                              {n.adviceRecordId ? (
                                <Badge variant="outline" className="text-xs">
                                  Advice #{n.adviceRecordId}
                                </Badge>
                              ) : null}
                              {n.previousNoteId ? (
                                <Badge
                                  variant="secondary"
                                  className="text-xs flex items-center gap-1"
                                  data-testid={`badge-amends-${n.id}`}
                                >
                                  <CornerUpRight className="h-3 w-3" />
                                  Amends note #{n.previousNoteId}
                                </Badge>
                              ) : null}
                            </div>
                            <p className="text-sm whitespace-pre-wrap">
                              {n.body}
                            </p>
                            {prev ? (
                              <details className="mt-2 text-xs text-gray-500">
                                <summary className="cursor-pointer">
                                  Show previous version
                                </summary>
                                <p className="whitespace-pre-wrap mt-1 pl-3 border-l-2 border-gray-200">
                                  {prev.body}
                                </p>
                              </details>
                            ) : null}
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setAmending(n);
                              setNoteOpen(true);
                            }}
                            data-testid={`button-amend-note-${n.id}`}
                          >
                            <Pencil className="h-4 w-4 mr-1" />
                            Amend
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <ObjectiveDialog
        open={objectiveOpen}
        onOpenChange={setObjectiveOpen}
        clientId={clientId}
        adviceRecords={adviceRecords}
      />
      <DocumentDialog
        open={documentOpen}
        onOpenChange={setDocumentOpen}
        clientId={clientId}
        adviceRecords={adviceRecords}
      />
      <NoteDialog
        open={noteOpen}
        onOpenChange={(o) => {
          setNoteOpen(o);
          if (!o) setAmending(null);
        }}
        clientUserId={clientId}
        adviceRecords={adviceRecords}
        amending={amending}
      />
    </div>
  );
}
