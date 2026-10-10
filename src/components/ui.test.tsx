import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ListRow, PageHeader, WorkspaceBackButton, WorkspaceBackContext } from "./ui";

describe("workspace header navigation", () => {
  it("renders the owning workspace return once in its leading slot", () => {
    const back = vi.fn();
    const view = render(<WorkspaceBackContext.Provider value={back}><PageHeader title="设置" density="workspace" /></WorkspaceBackContext.Provider>);
    const button = screen.getByRole("button", { name: "返回" });
    expect(view.container.querySelector(".page-header-back")).toContainElement(button);
    fireEvent.click(button);
    expect(back).toHaveBeenCalledOnce();
  });
  it("lets an explicit destination override the inherited return", () => {
    const inherited = vi.fn();
    const explicit = vi.fn();
    render(<WorkspaceBackContext.Provider value={inherited}><PageHeader title="搜索" density="workspace" back={<WorkspaceBackButton onClick={explicit}>返回日志</WorkspaceBackButton>} /></WorkspaceBackContext.Provider>);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "返回日志" }));
    expect(explicit).toHaveBeenCalledOnce();
    expect(inherited).not.toHaveBeenCalled();
  });
  it("does not fabricate a root return or inject one into legacy headers", () => {
    const view = render(<PageHeader title="今天" density="workspace" />);
    expect(screen.queryByRole("button")).toBeNull();
    view.rerender(<WorkspaceBackContext.Provider value={vi.fn()}><PageHeader title="旧页面" /></WorkspaceBackContext.Provider>);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ListRow", () => {
  it("keeps metadata and trailing affordance in one right-aligned end group", () => {
    render(<ListRow title="知识播客" meta="已配置" trailing={<span>›</span>} />);

    const end = document.querySelector(".list-row-end");
    expect(end).not.toBeNull();
    expect(end?.querySelector(".list-row-meta")).toHaveTextContent("已配置");
    expect(end?.querySelector(".list-row-trailing")).toHaveTextContent("›");
  });

  it("keeps a trailing affordance at the row end when metadata is absent", () => {
    render(<ListRow title="模板" trailing={<span>›</span>} />);

    expect(document.querySelector(".list-row-end .list-row-trailing")).toHaveTextContent("›");
    expect(document.querySelector(".list-row-meta")).toBeNull();
  });
});
