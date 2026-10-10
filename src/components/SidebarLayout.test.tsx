import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarLayout, SidebarPins } from "./SidebarLayout";
import { readSidebarPreference, writeSidebarPreference } from "../lib/sidebarLayout";
import type { RecordBlock } from "../types";

const sidebar = <aside className="sidebar"><button>日志</button></aside>;
const preference = () => readSidebarPreference();

describe("SidebarLayout", () => {
  beforeEach(() => { localStorage.clear(); Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true }); });
  it("keeps children mounted when collapsing and preserves expanded width", () => {
    writeSidebarPreference({ collapsed: false, width: 280 });
    render(<SidebarLayout className="app-shell" navigationKey="journal">{sidebar}<input aria-label="草稿" defaultValue="未保存" /></SidebarLayout>);
    const draft = screen.getByRole("textbox");
    fireEvent.click(screen.getByRole("button", { name: "收起左侧导航" }));
    expect(document.querySelector(".app-shell")).toHaveStyle({ "--sidebar-width": "64px" });
    expect(screen.getByRole("textbox")).toBe(draft);
    expect(preference()).toEqual({ collapsed: true, width: 280 });
    fireEvent.click(screen.getByRole("button", { name: "展开左侧导航" }));
    expect(document.querySelector(".app-shell")).toHaveStyle({ "--sidebar-width": "280px" });
  });
  it("supports bounded keyboard sizing and default reset", () => {
    render(<SidebarLayout className="app-shell" navigationKey="today">{sidebar}</SidebarLayout>);
    const resize = screen.getByRole("separator");
    fireEvent.keyDown(resize, { key: "End" });
    expect(resize).toHaveAttribute("aria-valuenow", "320");
    fireEvent.keyDown(resize, { key: "ArrowRight" });
    expect(preference()?.width).toBe(320);
    fireEvent.keyDown(resize, { key: "Home" });
    expect(preference()?.width).toBe(192);
    fireEvent.keyDown(resize, { key: "ArrowLeft" });
    expect(preference()?.width).toBe(192);
    fireEvent.doubleClick(resize);
    expect(preference()?.width).toBe(208);
  });
  it("migrates the legacy collapse once, never restores it on route back", () => {
    const { rerender } = render(<SidebarLayout className="app-shell" navigationKey="knowledge" legacyCollapsed>{sidebar}</SidebarLayout>);
    expect(preference()?.collapsed).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "展开左侧导航" }));
    rerender(<SidebarLayout className="app-shell" navigationKey="today" legacyCollapsed={false}>{sidebar}</SidebarLayout>);
    rerender(<SidebarLayout className="app-shell" navigationKey="knowledge" legacyCollapsed>{sidebar}</SidebarLayout>);
    expect(preference()?.collapsed).toBe(false);
    expect(screen.getByRole("button", { name: "收起左侧导航" })).toBeInTheDocument();
  });
  it("new local preference wins over legacy navigation", () => {
    writeSidebarPreference({ collapsed: false, width: 288 });
    render(<SidebarLayout className="app-shell" navigationKey="knowledge" legacyCollapsed>{sidebar}</SidebarLayout>);
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "288");
  });
  it("waits for a restored legacy collapsed flag before consuming migration", () => {
    const { rerender } = render(<SidebarLayout className="app-shell" navigationKey="today" legacyCollapsed={false}>{sidebar}</SidebarLayout>);
    rerender(<SidebarLayout className="app-shell" navigationKey="knowledge" legacyCollapsed>{sidebar}</SidebarLayout>);
    expect(preference()?.collapsed).toBe(true);
  });
  it("temporarily clamps after a window resize and restores on widening", async () => {
    writeSidebarPreference({ collapsed: false, width: 320 });
    render(<SidebarLayout className="app-shell" navigationKey="today">{sidebar}</SidebarLayout>);
    window.innerWidth = 960; fireEvent(window, new Event("resize"));
    await waitFor(() => expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "240"));
    expect(preference()?.width).toBe(320);
    window.innerWidth = 390; fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    window.innerWidth = 1440; fireEvent(window, new Event("resize"));
    expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "320");
  });
  it("preserves pinned actions, closes with Escape and returns focus", () => {
    writeSidebarPreference({ collapsed: true, width: 208 });
    const onOpen = vi.fn();
    const record = { id: "pin", title: "置顶正文" } as RecordBlock;
    render(<SidebarLayout className="app-shell" navigationKey="today"><SidebarPins records={[record]} onOpen={onOpen} /></SidebarLayout>);
    const trigger = screen.getByRole("button", { name: "置顶日志" });
    fireEvent.click(trigger);
    expect(screen.getByRole("region", { name: "置顶日志列表" })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "打开置顶日志 置顶正文" }));
    expect(onOpen).toHaveBeenCalledWith(record);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });
});
