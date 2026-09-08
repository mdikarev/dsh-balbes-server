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

  it("bumping refreshKey refetches the loaded root", async () => {
    const read = vi.fn(async () => rootBody);
    const api = { readWorkspaceDir: read } as unknown as AdminApi;
    const { rerender } = render(<FileTree api={api} workspace={alpha} refreshKey={0} />);
    expect(await screen.findByText("src")).toBeTruthy();
    rerender(<FileTree api={api} workspace={alpha} refreshKey={1} />);
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it("switching workspace resets the tree", async () => {
    const read = vi.fn(async (_s: string, n: string | undefined, p: string) =>
      p === "" && n === "alpha" ? rootBody : { entries: [] }
    );
    const api = { readWorkspaceDir: read } as unknown as AdminApi;
    const { rerender } = render(<FileTree api={api} workspace={alpha} refreshKey={0} />);
    expect(await screen.findByText("src")).toBeTruthy();
    rerender(<FileTree api={api} workspace={{ scope: "project", name: "beta" }} refreshKey={0} />);
    await waitFor(() => expect(read).toHaveBeenCalledWith("project", "beta", ""));
    expect(read).toHaveBeenCalledTimes(2);
  });
});
