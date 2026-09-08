import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import FileTree from "../src/components/FileTree";
import type { AdminApi } from "../src/api/client";
import type { WorkspaceTreeResponse } from "dsh-balbes-contracts";
import type { WorkspaceRef } from "../src/workspaceRef";

const alpha: WorkspaceRef = { scope: "project", name: "alpha" };
const rootBody: WorkspaceTreeResponse = { entries: [{ name: "src", kind: "dir" }, { name: "readme.md", kind: "file" }] };
const srcBody: WorkspaceTreeResponse = { entries: [{ name: "main.ts", kind: "file" }] };

function makeApi(dirResponses: Record<string, WorkspaceTreeResponse>): AdminApi {
  return {
    readWorkspaceDir: vi.fn(async (_scope, _name, path) => dirResponses[path] ?? { entries: [] }),
    subscribeWorkspaceEvents: vi.fn(() => () => {})
  } as unknown as AdminApi;
}

afterEach(() => cleanup());

describe("FileTree", () => {
  it("prompts to select a workspace when none is selected", () => {
    render(<FileTree api={makeApi({})} workspace={null} refreshKey={0} />);
    expect(screen.getByText("Выберите воркспейс")).toBeTruthy();
  });

  it("loads the root lazily and expands directories on demand", async () => {
    const api = makeApi({ "": rootBody, src: srcBody });
    render(<FileTree api={api} workspace={alpha} refreshKey={0} />);
    expect(await screen.findByText("src")).toBeTruthy();
    expect(screen.getByText("readme.md")).toBeTruthy();
    expect(screen.queryByText("main.ts")).toBeNull();
    fireEvent.click(screen.getByTestId("tree-dir-src"));
    expect(await screen.findByText("main.ts")).toBeTruthy();
    expect(api.readWorkspaceDir).toHaveBeenCalledWith("project", "alpha", "src");
  });

  it("shows an empty hint for an empty directory", async () => {
    const api = makeApi({ "": { entries: [] } });
    render(<FileTree api={api} workspace={alpha} refreshKey={0} />);
    expect(await screen.findByText("Каталог пуст")).toBeTruthy();
  });

  it("bumping refreshKey replaces the rendered root with the refetched listing", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ entries: [{ name: "src", kind: "dir" }, { name: "old.md", kind: "file" }] })
      .mockResolvedValueOnce({ entries: [{ name: "src", kind: "dir" }, { name: "new.md", kind: "file" }] });
    const api = { readWorkspaceDir: read } as unknown as AdminApi;
    const { rerender } = render(<FileTree api={api} workspace={alpha} refreshKey={0} />);
    expect(await screen.findByText("old.md")).toBeTruthy();
    rerender(<FileTree api={api} workspace={alpha} refreshKey={1} />);
    expect(await screen.findByText("new.md")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("old.md")).toBeNull());
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("bumping refreshKey refetches the root and every expanded dir, applying all fresh listings", async () => {
    let rootReads = 0;
    const read = vi.fn(async (_scope: string, _name: string | undefined, path: string) => {
      if (path === "") {
        rootReads += 1;
        return rootReads === 1
          ? { entries: [{ name: "src", kind: "dir" }, { name: "old.md", kind: "file" }] }
          : { entries: [{ name: "src", kind: "dir" }, { name: "new.md", kind: "file" }] };
      }
      return srcBody; // path === "src"
    });
    const api = { readWorkspaceDir: read } as unknown as AdminApi;
    const { rerender } = render(<FileTree api={api} workspace={alpha} refreshKey={0} />);
    fireEvent.click(await screen.findByTestId("tree-dir-src"));
    expect(await screen.findByText("main.ts")).toBeTruthy();
    expect(read).toHaveBeenCalledTimes(2);

    rerender(<FileTree api={api} workspace={alpha} refreshKey={1} />);
    // root and src are both re-read in the same burst; every fresh response is applied
    expect(await screen.findByText("new.md")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("old.md")).toBeNull());
    await waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    // the expanded branch must survive the refresh, still open with its children
    expect(screen.getByTestId("tree-dir-src").getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("main.ts")).toBeTruthy();
  });

  it("retries a failed dir load in place, keeping the branch expanded", async () => {
    let srcReads = 0;
    const read = vi.fn(async (_scope: string, _name: string | undefined, path: string) => {
      if (path === "src") {
        srcReads += 1;
        if (srcReads === 1) throw new Error("boom");
        return srcBody;
      }
      return rootBody;
    });
    const api = { readWorkspaceDir: read } as unknown as AdminApi;
    render(<FileTree api={api} workspace={alpha} refreshKey={0} />);
    fireEvent.click(await screen.findByTestId("tree-dir-src"));
    expect(await screen.findByText("boom")).toBeTruthy();
    expect(screen.getByTestId("tree-dir-src").getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByText("main.ts")).toBeTruthy();
    expect(screen.queryByText("boom")).toBeNull();
    expect(screen.getByTestId("tree-dir-src").getAttribute("aria-expanded")).toBe("true");
    expect(read).toHaveBeenCalledTimes(3); // root + failed src + src retry
  });

  it("switching workspace replaces the tree with the new workspace's content", async () => {
    const betaRoot: WorkspaceTreeResponse = { entries: [{ name: "beta-only.ts", kind: "file" }] };
    const read = vi.fn(async (_scope: string, name: string | undefined, path: string) => {
      if (path === "" && name === "alpha") return rootBody;
      if (path === "" && name === "beta") return betaRoot;
      return { entries: [] };
    });
    const api = { readWorkspaceDir: read } as unknown as AdminApi;
    const { rerender } = render(<FileTree api={api} workspace={alpha} refreshKey={0} />);
    expect(await screen.findByText("src")).toBeTruthy();
    rerender(<FileTree api={api} workspace={{ scope: "project", name: "beta" }} refreshKey={0} />);
    expect(await screen.findByText("beta-only.ts")).toBeTruthy();
    expect(screen.queryByText("src")).toBeNull();
    expect(screen.queryByText("readme.md")).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });
});
