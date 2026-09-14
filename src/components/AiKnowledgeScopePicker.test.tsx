import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecordBlock } from "../types";
import { todayISO } from "../lib/date";
import { AiKnowledgeScopePicker } from "./AiKnowledgeScopePicker";

const record = (id: string, subject: string, title: string, tags: string[] = []): RecordBlock => ({
  id,
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  type: "record",
  date: "2026-08-03",
  order: 0,
  subject,
  title,
  contentHtml: `<p>${title}</p>`,
  assets: [],
  formulas: [],
  mistakeRefs: [],
  tags,
});

const renderPicker = (blocks: RecordBlock[], onConfirm = vi.fn(), initialScope?: import("../types").AiKnowledgeScope) => render(
  <AiKnowledgeScopePicker
    blocks={blocks}
    assets={[]}
    includeDate
    initialScope={initialScope}
    title="选择范围"
    confirmLabel="确认范围"
    onBack={() => undefined}
    onConfirm={onConfirm}
  />,
);

describe("AiKnowledgeScopePicker", () => {
  it("explains when no formal subjects are available", () => {
    renderPicker([]);
    expect(screen.getByRole("option", { name: "没有可用学科" })).toBeInTheDocument();
    expect(screen.getByText("没有可用学科，请先保存正式日志。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "确认范围" })).toBeDisabled();
  });

  it("shows a saved-tag empty state instead of a blank selector", () => {
    renderPicker([record("r1", "数学", "极限")]);
    expect(screen.getByRole("option", { name: "该学科没有已保存标签" })).toBeInTheDocument();
    expect(screen.getByText("该学科没有已保存标签。")).toBeInTheDocument();
  });

  it("auto-selects the first saved tag and confirms the shared tag scope", async () => {
    const onConfirm = vi.fn();
    renderPicker([record("r1", "数学", "极限", ["重点", "错题"] )], onConfirm);

    await waitFor(() => expect(screen.getByRole("combobox", { name: "标签" })).toHaveValue("错题"));
    fireEvent.click(screen.getByRole("button", { name: "确认范围" }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({ kind: "tag", subject: "数学", tag: "错题" }));
  });

  it("supports the podcast-only date scope", async () => {
    const onConfirm = vi.fn();
    renderPicker([record("r1", "数学", "极限")], onConfirm, { kind: "date", date: "2026-08-03" });
    fireEvent.click(screen.getByRole("tab", { name: "按日期" }));
    fireEvent.click(screen.getByRole("button", { name: "确认范围" }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ kind: "date" })));
  });
});

/**
 * F-03: the date scope default must be the *local* calendar day.
 *
 * The removed implementation used `new Date().toISOString().slice(0, 10)`, which is
 * the UTC day. In UTC+8 that resolves to yesterday for every local time between
 * midnight and 08:00, so a user opening the picker in the morning got yesterday's
 * material with no indication that anything was wrong.
 */
describe("AiKnowledgeScopePicker date scope basis", () => {
  const originalTimezone = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTimezone;
    vi.useRealTimers();
  });

  it("defaults to the local day, not the UTC day, during the UTC+8 early-morning window", async () => {
    process.env.TZ = "Asia/Shanghai";
    vi.useFakeTimers({ toFake: ["Date"] });
    // 2026-09-13T16:30Z === 2026-09-14 00:30 in UTC+8.
    vi.setSystemTime(new Date("2026-09-13T16:30:00.000Z"));

    // The minimal trigger: the two readings of "today" disagree, and the UTC one is stale.
    expect(new Date().toISOString().slice(0, 10)).toBe("2026-09-13");
    expect(todayISO()).toBe("2026-09-14");

    const onConfirm = vi.fn();
    const view = renderPicker(
      [{ ...record("r1", "数学", "极限"), date: "2026-09-14" }],
      onConfirm,
    );
    fireEvent.click(screen.getByRole("tab", { name: "按日期" }));

    const dateInput = view.container.querySelector('input[type="date"]') as HTMLInputElement;
    expect(dateInput).toBeTruthy();
    expect(dateInput.value).toBe("2026-09-14");

    fireEvent.click(screen.getByRole("button", { name: "确认范围" }));
    await waitFor(() =>
      expect(onConfirm).toHaveBeenCalledWith({ kind: "date", date: "2026-09-14" }),
    );
  });

  it("still returns the local day outside the ambiguous window", () => {
    process.env.TZ = "Asia/Shanghai";
    vi.useFakeTimers({ toFake: ["Date"] });
    // 2026-09-14T04:00Z === 2026-09-14 12:00 in UTC+8: both readings agree.
    vi.setSystemTime(new Date("2026-09-14T04:00:00.000Z"));

    expect(new Date().toISOString().slice(0, 10)).toBe("2026-09-14");
    expect(todayISO()).toBe("2026-09-14");
  });
});
