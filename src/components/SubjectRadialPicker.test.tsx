import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SubjectConfig } from "../types";
import { SubjectRadialPicker, subjectOrbitIndexAfterDrag } from "./SubjectRadialPicker";

const stamp = "2026-09-20T00:00:00.000Z";
const subject = (id: string, name: string, order: number, archived = false): SubjectConfig => ({
  id, name, order, createdAt: stamp, updatedAt: stamp,
  ...(archived ? { archivedAt: stamp } : {}),
});

const subjects = [
  subject("math", "数学", 0),
  subject("physics", "物理", 1),
  subject("english", "英语", 2),
  subject("politics", "政治", 3),
  subject("algorithm", "数据结构与算法专题复习", 4),
  subject("history", "历史", 5),
  subject("archived", "已归档", 6, true),
];

const renderPicker = (onSelect = vi.fn(async () => undefined), items = subjects) => {
  const onClose = vi.fn();
  const onManageSubjects = vi.fn();
  render(<SubjectRadialPicker open subjects={items} onClose={onClose} onSelect={onSelect} onManageSubjects={onManageSubjects} />);
  return { onClose, onManageSubjects, onSelect };
};

describe("SubjectRadialPicker", () => {
  it("opens without creating and requires a focused-subject confirmation", async () => {
    const onSelect = vi.fn(async () => undefined);
    renderPicker(onSelect);

    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "聚焦学科物理" }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "物理" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "创建物理日志" }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith("物理"));
  });

  it("moves through an arbitrarily long list by snapping one slot per drag threshold", () => {
    expect(subjectOrbitIndexAfterDrag(0, -60, 12)).toBe(1);
    expect(subjectOrbitIndexAfterDrag(5, 120, 12)).toBe(3);
    expect(subjectOrbitIndexAfterDrag(0, 120, 12)).toBe(0);
    expect(subjectOrbitIndexAfterDrag(11, -120, 12)).toBe(11);
  });

  it("keeps long names available in the focus heading and the complete-list fallback", () => {
    renderPicker();
    fireEvent.click(screen.getByRole("button", { name: "全部学科" }));

    expect(screen.getByRole("button", { name: /数据结构与算法专题复习/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /已归档/ })).not.toBeInTheDocument();
  });

  it("closes without creating and sends an empty state to subject management", () => {
    const openPicker = renderPicker();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(openPicker.onClose).toHaveBeenCalledTimes(1);
    expect(openPicker.onSelect).not.toHaveBeenCalled();

    const emptyPicker = renderPicker(vi.fn(async () => undefined), []);
    fireEvent.click(screen.getByRole("button", { name: "前往学科分类" }));
    expect(emptyPicker.onManageSubjects).toHaveBeenCalledTimes(1);
    expect(emptyPicker.onSelect).not.toHaveBeenCalled();
  });
});
