import { describe, expect, it } from "vitest";
import type {
  LoginRequest,
  PromptResponse,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceDeleteRequest,
  WorkspaceDeleteResponse,
  WorkspaceFsEvent,
  WorkspaceHome,
  WorkspaceListEvent,
  WorkspaceListRequest,
  WorkspaceListResponse,
  WorkspaceProject,
  WorkspaceScope,
  WorkspaceTreeEntry,
  WorkspaceTreeEntryKind,
  WorkspaceTreeRequest,
  WorkspaceTreeResponse,
  WorkspaceEvent
} from "../src/index.js";

describe("contracts", () => {
  it("LoginRequest describes login/password fields", () => {
    const req: LoginRequest = { login: "balbes-x", password: "secret" };
    expect(JSON.parse(JSON.stringify(req))).toEqual(req);
  });

  it("PromptResponse carries text and an optional reason", () => {
    const ok: PromptResponse = { text: "ok" };
    const err: PromptResponse = { text: "", reason: { kind: "error", code: "E", message: "m" } };
    expect(ok.text).toBe("ok");
    expect(err.reason?.code).toBe("E");
  });
});

// Workspace contracts — structural shape is the contract (R-API-1 + types win).
describe("workspace contracts", () => {
  it("shapes line up with the documented API", () => {
    const listReq: WorkspaceListRequest = {};
    const listRes: WorkspaceListResponse = {
      home: { path: "/home/u/.dsh/agent" },
      projects: [{ name: "alpha", path: "/home/u/.dsh/projects/alpha", createdAt: "2026-09-06T00:00:00.000Z" }]
    };
    const handMade: WorkspaceProject = { name: "hand", path: "/home/u/.dsh/projects/hand" }; // createdAt optional
    const createReq: WorkspaceCreateRequest = { name: "alpha" };
    const createRes: WorkspaceCreateResponse = {
      project: { name: "alpha", path: "/home/u/.dsh/projects/alpha", createdAt: "2026-09-06T00:00:00.000Z" }
    };
    const deleteReq: WorkspaceDeleteRequest = { name: "alpha" };
    const deleteRes: WorkspaceDeleteResponse = {};
    const home: WorkspaceHome = { path: "/home/u/.dsh/agent" };
    expect(listReq).toEqual({});
    expect(JSON.parse(JSON.stringify(listRes))).toEqual({
      home: { path: "/home/u/.dsh/agent" },
      projects: [{ name: "alpha", path: "/home/u/.dsh/projects/alpha", createdAt: "2026-09-06T00:00:00.000Z" }]
    });
    expect(handMade.createdAt).toBeUndefined();
    expect(createReq).toEqual({ name: "alpha" });
    expect(createRes.project).toEqual(listRes.projects[0]);
    expect(deleteReq).toEqual({ name: "alpha" });
    expect(deleteRes).toEqual({});
    expect(home).toEqual({ path: "/home/u/.dsh/agent" });
  });
});

// Workspace tree/events contracts — structural shape is the contract (R-API-1 + types win).
describe("workspace tree/events contracts", () => {
  it("exposes the documented shapes", () => {
    const scope: WorkspaceScope = "project";
    const req: WorkspaceTreeRequest = { scope, name: "alpha", path: "src" };
    const homeReq: WorkspaceTreeRequest = { scope: "home", path: "" };
    const entry: WorkspaceTreeEntry = { name: "main.ts", kind: "file" };
    const kind: WorkspaceTreeEntryKind = "dir";
    const resp: WorkspaceTreeResponse = { entries: [entry] };
    const fsEvt: WorkspaceFsEvent = { kind: "fs", scope, name: "alpha", path: "src" };
    const listEvt: WorkspaceListEvent = { kind: "list" };
    const evt: WorkspaceEvent = fsEvt;
    void ([scope, req, homeReq, entry, kind, resp, fsEvt, listEvt, evt] as unknown[]);
    // exactOptionalPropertyTypes guard: an omitted name is absent, never undefined
    const e = evt as WorkspaceFsEvent;
    void e;
  });
});
