// =============================================================================
// Task #382 — client document download flow
// -----------------------------------------------------------------------------
// Task #115 added a Download button on the client documents page that fires
// `/api/client/documents/:id/download`, saves the streamed bytes locally
// using the original filename, and translates a 404 into the friendly
// "Document not available" toast via `explainDownloadError`.
//
// Lives in its own file (not the sibling wealth-planner.test.tsx) because
// that suite installs `vi.useFakeTimers()` at the file level for its CAGR
// calculations and the download flow leans on real `setTimeout(..., 0)` for
// the object-URL revoke. Splitting keeps both suites honest without either
// one having to muck with the other's timer setup.
//
// The coverage matrix:
//   - downloadClientDocument: hits the per-id URL, saves with the original
//     filename, falls back to "document" when no name is provided, and
//     revokes the temporary object URL on the next tick.
//   - explainDownloadError: maps the 404 / non-404 / non-JSON / non-Error
//     cases to the right toast title + description.
//   - ClientWealthPlanner page wiring: clicking Download on a row fires the
//     real handler, which calls apiFetch with the row's id and surfaces the
//     toast on a 404 — guards against a refactor that forgets to thread
//     `doc.fileName` or swaps the URL.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  type QueryObserverSuccessResult,
} from "@tanstack/react-query";

// Same hook stub the sibling suite uses — the page needs a portfolio total
// even though it doesn't drive the download flow, otherwise the objectives
// table render under the active tab throws.
vi.mock("@/hooks/use-portfolio", () => ({
  usePortfolioAllocation: vi.fn(),
}));

// Mock apiFetch so the download path never hits the network. The default
// queryFn (used for the cached useQuery seeds below) goes through raw
// fetch, not apiFetch, so pre-seeded query data is unaffected.
vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/queryClient")>();
  return {
    ...actual,
    apiFetch: vi.fn(),
  };
});

import ClientWealthPlanner, {
  downloadClientDocument,
  explainDownloadError,
} from "./wealth-planner";
import { usePortfolioAllocation } from "@/hooks/use-portfolio";
import { apiFetch } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";

const mockedUsePortfolioAllocation = vi.mocked(usePortfolioAllocation);
const mockedApiFetch = vi.mocked(apiFetch);

type AllocationData = { totalValue: number };
function buildAllocationSuccess(
  totalValue: number,
): QueryObserverSuccessResult<AllocationData, Error> {
  const data: AllocationData = { totalValue };
  const result: QueryObserverSuccessResult<AllocationData, Error> = {
    data,
    dataUpdatedAt: 0,
    error: null,
    errorUpdateCount: 0,
    errorUpdatedAt: 0,
    failureCount: 0,
    failureReason: null,
    fetchStatus: "idle",
    isError: false,
    isFetched: true,
    isFetchedAfterMount: true,
    isFetching: false,
    isInitialLoading: false,
    isLoading: false,
    isLoadingError: false,
    isPaused: false,
    isPending: false,
    isPlaceholderData: false,
    isRefetchError: false,
    isRefetching: false,
    isStale: false,
    isSuccess: true,
    promise: Promise.resolve(data),
    refetch: () => Promise.resolve(result),
    status: "success",
  };
  return result;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// downloadClientDocument
// ---------------------------------------------------------------------------
describe("downloadClientDocument", () => {
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let createElementSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // jsdom may not ship URL.createObjectURL — back-fill the symbols so the
    // spy can attach. The mocks below override the implementations anyway.
    if (typeof URL.createObjectURL !== "function") {
      // @ts-expect-error - jsdom shim
      URL.createObjectURL = () => "";
      // @ts-expect-error - jsdom shim
      URL.revokeObjectURL = () => {};
    }
    createObjectURLSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:fake-object-url");
    revokeObjectURLSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});
    createElementSpy = vi.spyOn(document, "createElement");
  });

  afterEach(() => {
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
    createElementSpy.mockRestore();
  });

  function captureAnchor(): { current: HTMLAnchorElement | null } {
    const ref: { current: HTMLAnchorElement | null } = { current: null };
    createElementSpy.mockImplementation((tag: string) => {
      // Construct via the prototype so we don't recurse through our own spy.
      const el = Object.getPrototypeOf(document).createElement.call(
        document,
        tag,
      );
      if (tag.toLowerCase() === "a") ref.current = el as HTMLAnchorElement;
      return el;
    });
    return ref;
  }

  it("hits the per-id download URL and saves the blob with the original filename", async () => {
    // jsdom's Response constructor calls Blob.prototype.stream(), which the
    // shim doesn't implement — pass a string body and let the Response
    // convert to a Blob via .blob() on read.
    mockedApiFetch.mockResolvedValueOnce(
      new Response("pdf-bytes", {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      }),
    );
    const anchor = captureAnchor();

    await downloadClientDocument(42, "fact-find.pdf");

    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/client/documents/42/download",
    );
    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(anchor.current).not.toBeNull();
    // The helper sets `a.download = fileName` so the saved file matches the
    // upload's original name. Content-Disposition is unreliable across
    // browsers, hence the manual filename drive.
    expect(anchor.current!.download).toBe("fact-find.pdf");
    expect(anchor.current!.href).toContain("blob:fake-object-url");

    // Object URL is revoked on the next tick so the browser has a chance to
    // start the download before the underlying blob disappears.
    await new Promise((r) => setTimeout(r, 5));
    expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:fake-object-url");
  });

  it("falls back to 'document' when the row has no filename", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      new Response("x", { status: 200 }),
    );
    const anchor = captureAnchor();

    await downloadClientDocument(7, "");

    expect(anchor.current!.download).toBe("document");
  });
});

// ---------------------------------------------------------------------------
// explainDownloadError
// ---------------------------------------------------------------------------
describe("explainDownloadError", () => {
  it("maps a 404 status to the 'Document not available' title", () => {
    // apiFetch throws Errors of the form `${status}: ${body}`; the body is
    // typically a JSON envelope from the server so the helper digs out the
    // inner `error` field for the toast description.
    const err = new Error('404: {"error":"Document not found"}');
    expect(explainDownloadError(err)).toEqual({
      title: "Document not available",
      description: "Document not found",
    });
  });

  it("falls back to the generic title for non-404 statuses", () => {
    const err = new Error('500: {"error":"Storage backend offline"}');
    expect(explainDownloadError(err)).toEqual({
      title: "Could not download document",
      description: "Storage backend offline",
    });
  });

  it("keeps the raw body when the response isn't a JSON envelope", () => {
    // Plain-text error bodies (or non-prefixed Errors) should still surface
    // something useful in the toast — the helper preserves the raw body
    // as the description rather than swallowing it.
    const err = new Error("404: nothing here");
    expect(explainDownloadError(err)).toEqual({
      title: "Document not available",
      description: "nothing here",
    });
  });

  it("handles non-Error throwables without crashing", () => {
    expect(explainDownloadError("totally unstructured")).toEqual({
      title: "Could not download document",
      description: "Unexpected error",
    });
  });
});

// ---------------------------------------------------------------------------
// ClientWealthPlanner page wiring — Download button → helper → toast
// ---------------------------------------------------------------------------
describe("ClientWealthPlanner — Download button", () => {
  beforeEach(() => {
    if (typeof URL.createObjectURL !== "function") {
      // @ts-expect-error - jsdom shim
      URL.createObjectURL = () => "";
      // @ts-expect-error - jsdom shim
      URL.revokeObjectURL = () => {};
    }
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  });

  function renderWithDocs(
    docs: Array<{
      id: number;
      fileName: string;
    }>,
  ) {
    mockedUsePortfolioAllocation.mockReturnValue(buildAllocationSuccess(0));
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(["/api/client/objectives"], { items: [] });
    client.setQueryData(["/api/client/documents"], {
      items: docs.map((d) => ({
        id: d.id,
        adviceRecordId: null,
        documentType: "fact_find",
        fileName: d.fileName,
        storageKey: "k",
        mimeType: "application/pdf",
        fileSizeBytes: 1024,
        description: null,
        uploadedAt: "2026-04-01T00:00:00.000Z",
        retentionUntil: "2033-04-01T00:00:00.000Z",
        deletionLocked: true,
      })),
    });
    return render(
      <QueryClientProvider client={client}>
        <ClientWealthPlanner />
        {/* Toaster is mounted at app root in production; mount it here so
            error/success toast titles surface as DOM nodes the test can
            query for. */}
        <Toaster />
      </QueryClientProvider>,
    );
  }

  // Radix Tabs only mounts the active panel, so we have to actually
  // activate the documents tab before the download button exists in the
  // DOM. Looking at @radix-ui/react-tabs@1.1.4 the trigger commits the
  // value change from `onMouseDown` (not `onClick`) — fire that
  // explicitly so the panel mounts before findBy* runs.
  function activateDocumentsTab() {
    const tab = screen.getByTestId("tab-client-documents");
    fireEvent.mouseDown(tab, { button: 0 });
  }

  it("calls the download endpoint with the document id when Download is clicked", async () => {
    mockedApiFetch.mockResolvedValueOnce(
      new Response("x", { status: 200 }),
    );

    renderWithDocs([{ id: 555, fileName: "statement.pdf" }]);
    activateDocumentsTab();

    const btn = await screen.findByTestId("button-download-document-555");
    fireEvent.click(btn);

    await waitFor(() => {
      expect(mockedApiFetch).toHaveBeenCalledWith(
        "/api/client/documents/555/download",
      );
    });
  });

  it("surfaces the friendly 'Document not available' toast on a 404", async () => {
    // apiFetch's contract on a non-OK response is to throw an Error of the
    // form `${status}: ${body}`. The page passes that through
    // explainDownloadError before showing the toast — this guard pins both
    // the wiring and the translation in one shot.
    mockedApiFetch.mockRejectedValueOnce(
      new Error('404: {"error":"Document not found"}'),
    );

    renderWithDocs([{ id: 777, fileName: "missing.pdf" }]);
    activateDocumentsTab();
    const btn = await screen.findByTestId("button-download-document-777");
    fireEvent.click(btn);

    expect(await screen.findByText("Document not available")).toBeTruthy();
    expect(screen.getByText("Document not found")).toBeTruthy();
  });
});
