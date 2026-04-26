import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Target, FileText, FileBadge, ExternalLink } from "lucide-react";

interface ClientObjective {
  id: number;
  adviceRecordId: number;
  objectiveType: string;
  label: string;
  targetAmount: string | null;
  targetCurrency: string;
  targetDate: string | null;
  priority: string;
  notes: string | null;
  createdAt: string | null;
}

interface ClientDocument {
  id: number;
  adviceRecordId: number | null;
  documentType: string;
  fileName: string;
  storageKey: string;
  mimeType: string | null;
  fileSizeBytes: number | null;
  description: string | null;
  uploadedAt: string | null;
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

function formatBytes(n: number | null): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function ClientWealthPlanner() {
  const objectives = useQuery<{ items: ClientObjective[] }>({
    queryKey: ["/api/client/objectives"],
  });
  const documents = useQuery<{ items: ClientDocument[] }>({
    queryKey: ["/api/client/documents"],
  });

  return (
    <div className="p-6 space-y-6" data-testid="page-client-wealth-planner">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Wealth planner</h1>
        <p className="text-sm text-gray-500">
          Your structured objectives and the documents your adviser has on file.
        </p>
      </div>

      <Tabs defaultValue="objectives" className="space-y-4">
        <TabsList>
          <TabsTrigger value="objectives" data-testid="tab-client-objectives">
            <Target className="h-4 w-4 mr-2" /> Objectives
          </TabsTrigger>
          <TabsTrigger value="documents" data-testid="tab-client-documents">
            <FileText className="h-4 w-4 mr-2" /> Documents
          </TabsTrigger>
        </TabsList>

        {/* OBJECTIVES */}
        <TabsContent value="objectives">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Target className="h-4 w-4 text-violet-500" />
                Your objectives
              </CardTitle>
            </CardHeader>
            <CardContent>
              {objectives.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : objectives.isError ? (
                <p className="text-sm text-red-600">
                  Unable to load your objectives.
                </p>
              ) : (objectives.data?.items ?? []).length === 0 ? (
                <p
                  className="text-sm text-gray-500"
                  data-testid="text-no-objectives"
                >
                  Your adviser has not recorded any objectives yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Label</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead className="text-right">Target</TableHead>
                      <TableHead>Advice</TableHead>
                      <TableHead>Recorded</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(objectives.data?.items ?? []).map((o) => (
                      <TableRow
                        key={o.id}
                        data-testid={`row-client-objective-${o.id}`}
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
                              o.priority === "primary"
                                ? "default"
                                : "secondary"
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
                        <TableCell className="text-sm">
                          <Link
                            href={`/client/advice/${o.adviceRecordId}`}
                            className="text-sky-600 hover:underline inline-flex items-center gap-1"
                            data-testid={`link-advice-${o.adviceRecordId}`}
                          >
                            #{o.adviceRecordId}
                            <ExternalLink className="h-3 w-3" />
                          </Link>
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
        <TabsContent value="documents">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <FileBadge className="h-4 w-4 text-sky-500" />
                Your documents
              </CardTitle>
            </CardHeader>
            <CardContent>
              {documents.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : documents.isError ? (
                <p className="text-sm text-red-600">
                  Unable to load your documents.
                </p>
              ) : (documents.data?.items ?? []).length === 0 ? (
                <p
                  className="text-sm text-gray-500"
                  data-testid="text-no-documents"
                >
                  No documents are on file. Your adviser will upload fact-finds
                  and statements here.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>File</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Advice</TableHead>
                      <TableHead>Size</TableHead>
                      <TableHead>Uploaded</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(documents.data?.items ?? []).map((d) => (
                      <TableRow
                        key={d.id}
                        data-testid={`row-client-document-${d.id}`}
                      >
                        <TableCell className="text-sm">
                          <div className="font-medium">{d.fileName}</div>
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
                          {d.adviceRecordId ? (
                            <Link
                              href={`/client/advice/${d.adviceRecordId}`}
                              className="text-sky-600 hover:underline inline-flex items-center gap-1"
                            >
                              #{d.adviceRecordId}
                              <ExternalLink className="h-3 w-3" />
                            </Link>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-sm tabular-nums">
                          {formatBytes(d.fileSizeBytes)}
                        </TableCell>
                        <TableCell className="text-sm text-gray-500">
                          {formatDate(d.uploadedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
