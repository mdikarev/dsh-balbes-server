import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import FileView from "../src/components/FileView";
import type { AdminApi } from "../src/api/client";
import type { WorkspaceFileResponse } from "dsh-balbes-contracts";

function makeApi(overrides: Partial<AdminApi> = {}): AdminApi {
  return {
    readWorkspaceFile: vi.fn(async () => ({ file: { kind: "text", content: "hi", truncated: false } })),
    ...overrides
  } as unknown as AdminApi;
}

afterEach(() => cleanup());

describe("FileView", () => {
  it("renders text content and requests the file", async () => {
    const api = makeApi();
    render(<FileView api={api} workspace={{ scope: "project", name: "alpha" }} path="notes.txt" reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("file-content")).toBeDefined());
    expect(api.readWorkspaceFile).toHaveBeenCalledWith("project", "alpha", "notes.txt");
    expect(screen.getByTestId("file-content").textContent).toBe("hi");
  });

  it("shows the truncation note", async () => {
    const api = makeApi({
      readWorkspaceFile: vi.fn(async (): Promise<WorkspaceFileResponse> => ({ file: { kind: "text", content: "abc", truncated: true } }))
    });
    render(<FileView api={api} workspace={{ scope: "home" }} path="big.txt" reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("file-truncated")).toBeDefined());
  });

  it("shows empty, binary and link states", async () => {
    const empty = makeApi({ readWorkspaceFile: vi.fn(async (): Promise<WorkspaceFileResponse> => ({ file: { kind: "text", content: "", truncated: false } })) });
    const { rerender } = render(<FileView api={empty} workspace={{ scope: "home" }} path="e.txt" reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("file-empty")).toBeDefined());

    const binary = makeApi({ readWorkspaceFile: vi.fn(async (): Promise<WorkspaceFileResponse> => ({ file: { kind: "binary", size: 12 } })) });
    rerender(<FileView api={binary} workspace={{ scope: "home" }} path="b.bin" reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("file-binary").textContent).toContain("12"));

    const link = makeApi({ readWorkspaceFile: vi.fn(async (): Promise<WorkspaceFileResponse> => ({ file: { kind: "link" } })) });
    rerender(<FileView api={link} workspace={{ scope: "home" }} path="l" reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("file-link")).toBeDefined());
  });

  it("shows an error with retry", async () => {
    const readWorkspaceFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ file: { kind: "text", content: "ok", truncated: false } });
    render(<FileView api={makeApi({ readWorkspaceFile })} workspace={{ scope: "home" }} path="x.txt" reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("file-error")).toBeDefined());
    fireEvent.click(screen.getByTestId("file-retry"));
    await waitFor(() => expect(screen.getByTestId("file-content")).toBeDefined());
  });

  it("does not apply a stale response after the path changes", async () => {
    const deferred: Array<(value: WorkspaceFileResponse) => void> = [];
    const readWorkspaceFile = vi.fn(
      () => new Promise<WorkspaceFileResponse>((resolve) => deferred.push(resolve))
    );
    const api = makeApi({ readWorkspaceFile });
    const { rerender } = render(<FileView api={api} workspace={{ scope: "home" }} path="a.txt" reloadKey={0} />);
    rerender(<FileView api={api} workspace={{ scope: "home" }} path="b.txt" reloadKey={0} />);
    deferred[1]?.({ file: { kind: "text", content: "new", truncated: false } });
    deferred[0]?.({ file: { kind: "text", content: "old", truncated: false } });
    await waitFor(() => expect(screen.getByTestId("file-content").textContent).toBe("new"));
  });

  it("shows loading again when the path changes", async () => {
    const readWorkspaceFile = vi
      .fn()
      .mockResolvedValueOnce({ file: { kind: "text", content: "a", truncated: false } })
      .mockImplementationOnce(() => new Promise(() => {}));
    const api = makeApi({ readWorkspaceFile });
    const { rerender } = render(<FileView api={api} workspace={{ scope: "home" }} path="a.txt" reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("file-content")).toBeDefined());
    rerender(<FileView api={api} workspace={{ scope: "home" }} path="b.txt" reloadKey={0} />);
    await waitFor(() => expect(screen.getByTestId("file-loading")).toBeDefined());
    expect(screen.queryByTestId("file-content")).toBeNull();
  });

  it("makes no request without a workspace", () => {
    const api = makeApi();
    render(<FileView api={api} workspace={null} path="x.txt" reloadKey={0} />);
    expect(api.readWorkspaceFile).not.toHaveBeenCalled();
  });
});
