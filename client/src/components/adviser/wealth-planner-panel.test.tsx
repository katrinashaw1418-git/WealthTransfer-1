// =============================================================================
// Task #382 — adviser DocumentDialog upload flow + explainUploadError table
// -----------------------------------------------------------------------------
// Task #115 wired the adviser "Upload document" dialog to the real multipart
// endpoint (`POST /api/adviser/client-documents/upload`) and translated the
// server's structured upload-rejection codes into friendly toast titles. The
// only verification today is manual — these tests pin the contract so a
// future refactor can't silently regress:
//
//   1. The happy path: pick a file → POST a multipart body that carries
//      every field the route expects → on 200 we surface the success toast
//      AND invalidate the adviser's documents query so the table refreshes.
//   2. Each well-known rejection code from `explainUploadError`
//      (UPLOAD_TOO_LARGE / UPLOAD_MIME_REJECTED / UPLOAD_MIME_MISMATCH /
//      423 locked) maps to the exact toast title the adviser should see.
//
// We mock `apiUpload` (not `fetch`) because XHR's progress + abort hooks are
// flaky under jsdom and the dialog already trusts apiUpload's contract — we
// just need to prove the dialog calls it correctly and reacts to its result.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock apiUpload (and re-use the real ApiUploadError class so the dialog's
// `instanceof ApiUploadError` branch in onError still fires).
vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queryClient")>();
  return {
    ...actual,
    apiUpload: vi.fn(),
  };
});

// The Toaster portal renders into document.body; we don't need to mount it
// here because the toast reducer's state is observable through the hook —
// but for the upload-flow test we want to see the rendered toast. Mount the
// real Toaster so the success toast actually appears in the DOM.
import { Toaster } from "@/components/ui/toaster";

import {
  DocumentDialog,
  explainUploadError,
} from "./wealth-planner-panel";
import {
  apiUpload,
  ApiUploadError,
  queryClient as appQueryClient,
} from "@/lib/queryClient";

const mockedApiUpload = vi.mocked(apiUpload);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// explainUploadError — table-driven
// ---------------------------------------------------------------------------
// Pinning every well-known code here means a future refactor of the
// translation map (or a server-side rename of one of the codes) shows up as
// a visible test failure rather than a silently-wrong toast in production.
describe("explainUploadError", () => {
  type Case = {
    name: string;
    err: unknown;
    title: string;
    descriptionContains: string;
  };
  const cases: Case[] = [
    {
      name: "UPLOAD_TOO_LARGE → 'File is too large'",
      err: new ApiUploadError("File exceeds 25 MB", {
        status: 413,
        code: "UPLOAD_TOO_LARGE",
      }),
      title: "File is too large",
      descriptionContains: "File exceeds 25 MB",
    },
    {
      name: "UPLOAD_MIME_REJECTED → 'File type is not allowed'",
      err: new ApiUploadError("Type application/x-msdownload not allowed", {
        status: 415,
        code: "UPLOAD_MIME_REJECTED",
      }),
      title: "File type is not allowed",
      descriptionContains: "application/x-msdownload",
    },
    {
      name: "UPLOAD_MIME_MISMATCH → 'File contents don't match the file type'",
      err: new ApiUploadError("Detected image/png, declared application/pdf", {
        status: 415,
        code: "UPLOAD_MIME_MISMATCH",
      }),
      title: "File contents don't match the file type",
      descriptionContains: "Detected image/png",
    },
    {
      name: "UPLOAD_REJECTED → 'Upload was rejected'",
      err: new ApiUploadError("Antivirus flagged the upload", {
        status: 422,
        code: "UPLOAD_REJECTED",
      }),
      title: "Upload was rejected",
      descriptionContains: "Antivirus flagged",
    },
    {
      // Task #107 — 423 Locked has no `code`, just a status. The default
      // branch in explainUploadError checks `err.status === 423` and
      // surfaces a "review" title so advisers know the record is locked.
      name: "423 Locked (no code) → 'Advice record is under review'",
      err: new ApiUploadError("Advice record #42 is under review", {
        status: 423,
      }),
      title: "Advice record is under review",
      descriptionContains: "Advice record #42 is under review",
    },
    {
      name: "Unknown code → falls back to 'Could not upload document'",
      err: new ApiUploadError("Some new server error", {
        status: 500,
        code: "SOMETHING_UNKNOWN",
      }),
      title: "Could not upload document",
      descriptionContains: "Some new server error",
    },
    {
      name: "Plain Error (network failure) → generic title with raw message",
      err: new Error("Network error during upload"),
      title: "Could not upload document",
      descriptionContains: "Network error during upload",
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const out = explainUploadError(tc.err);
      expect(out.title).toBe(tc.title);
      expect(out.description).toContain(tc.descriptionContains);
    });
  }
});

// ---------------------------------------------------------------------------
// DocumentDialog — happy path + rejection toasts
// ---------------------------------------------------------------------------
function renderDialog(opts?: {
  invalidateSpy?: ReturnType<typeof vi.fn>;
  client?: QueryClient;
}) {
  const onOpenChange = vi.fn();
  const client =
    opts?.client ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity },
        mutations: { retry: false },
      },
    });
  // Stub a "linked" advice record so the Select has a non-locked option for
  // pinning. The happy-path test exercises the unpinned default ("none")
  // since that's the simplest body the route accepts.
  const adviceRecords = [
    {
      id: 7,
      adviceType: "comprehensive",
      status: "draft",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  return {
    onOpenChange,
    client,
    ...render(
      <QueryClientProvider client={client}>
        <DocumentDialog
          open
          onOpenChange={onOpenChange}
          clientId={123}
          adviceRecords={adviceRecords}
        />
        <Toaster />
      </QueryClientProvider>,
    ),
  };
}

describe("DocumentDialog upload flow", () => {
  it("posts a multipart body and surfaces the success toast + cache invalidation", async () => {
    // Server returns the inserted row; the dialog only reads the response
    // for the side effect of resolving the mutation.
    mockedApiUpload.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 901 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    // The dialog calls `queryClient.invalidateQueries(...)` on the
    // queryClient *imported from @/lib/queryClient*, NOT on the
    // QueryClientProvider's client. Spy on the imported singleton so the
    // invalidation call is observable here.
    const invalidateSpy = vi.spyOn(appQueryClient, "invalidateQueries");

    const { onOpenChange } = renderDialog();

    // Pick a file. fireEvent.change with a `files` array is the canonical
    // way to drive a file input under jsdom.
    const file = new File(["pdf-bytes"], "fact-find.pdf", {
      type: "application/pdf",
    });
    const input = screen.getByTestId("input-document-file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });

    // Submit. The button label is "Upload document" before the upload kicks
    // off and switches to "Uploading…" once the mutation is in flight.
    const submit = screen.getByTestId("button-submit-document");
    fireEvent.click(submit);

    // The dialog should have called apiUpload exactly once with the
    // multipart endpoint and a FormData body carrying every field the
    // route expects.
    await waitFor(() => {
      expect(mockedApiUpload).toHaveBeenCalledTimes(1);
    });
    const [url, body] = mockedApiUpload.mock.calls[0];
    expect(url).toBe("/api/adviser/client-documents/upload");
    expect(body).toBeInstanceOf(FormData);
    const fd = body as FormData;
    expect(fd.get("clientId")).toBe("123");
    expect(fd.get("documentType")).toBe("fact_find");
    expect(fd.get("file")).toBeInstanceOf(File);
    expect((fd.get("file") as File).name).toBe("fact-find.pdf");
    // Default unpinned upload — adviceRecordId is intentionally omitted
    // from the body when the user keeps the "Not pinned" option.
    expect(fd.has("adviceRecordId")).toBe(false);

    // Success toast renders into the Toaster portal we mounted alongside
    // the dialog. The dialog also calls onOpenChange(false) so the parent
    // closes it.
    expect(await screen.findByText("Document uploaded")).toBeTruthy();
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    // Cache invalidation: the mutation invalidates the adviser documents
    // queryKey for this client so the row appears in the table without a
    // hard refresh.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ["/api/adviser/client-documents", 123],
    });
  });

  it("surfaces 'File is too large' when the server returns UPLOAD_TOO_LARGE", async () => {
    mockedApiUpload.mockRejectedValueOnce(
      new ApiUploadError("File exceeds 25 MB limit", {
        status: 413,
        code: "UPLOAD_TOO_LARGE",
      }),
    );

    renderDialog();
    const file = new File(["x".repeat(10)], "huge.pdf", {
      type: "application/pdf",
    });
    fireEvent.change(screen.getByTestId("input-document-file"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByTestId("button-submit-document"));

    expect(await screen.findByText("File is too large")).toBeTruthy();
    expect(screen.getByText(/File exceeds 25 MB/)).toBeTruthy();
  });

  it("surfaces 'Advice record is under review' when the server returns 423", async () => {
    // The 423 path has no `code` — just the status — so this guards the
    // status-only branch in explainUploadError that the table-driven test
    // above also pins.
    mockedApiUpload.mockRejectedValueOnce(
      new ApiUploadError("Advice record #7 is under review", { status: 423 }),
    );

    renderDialog();
    fireEvent.change(screen.getByTestId("input-document-file"), {
      target: {
        files: [new File(["x"], "a.pdf", { type: "application/pdf" })],
      },
    });
    fireEvent.click(screen.getByTestId("button-submit-document"));

    expect(
      await screen.findByText("Advice record is under review"),
    ).toBeTruthy();
  });

  it("blocks submit until a file is picked", () => {
    renderDialog();
    // No file chosen yet — the submit button is disabled and tooltips
    // explain why. The disabled attribute alone is the visible regression
    // guard; clicking would do nothing.
    const submit = screen.getByTestId(
      "button-submit-document",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });
});
