import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RecordBlock, RecordReviewLog, RecordReviewState } from "../types";

vi.mock("../lib/date", () => ({
  todayISO: () => "2026-07-03",
}));

import { RecordCard } from "./RecordCard";

const record: RecordBlock = {
  id: "record-1",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  type: "record",
  date: "2026-06-01",
  order: 0,
  subject: "操作系统",
  tags: [],
  title: "进程同步与互斥",
  contentHtml: "<p>信号量机制实现</p>",
  assets: [],
  formulas: [],
  mistakeRefs: [],
};

const review = (patch: Partial<RecordReviewState> = {}): RecordReviewState => ({
  id: "record-1",
  recordId: "record-1",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  status: "active",
  easeFactor: 2.5,
  repetition: 1,
  intervalDays: 1,
  nextReviewDate: "2026-07-02",
  consecutiveRemembered: 1,
  totalReviews: 2,
  ...patch,
});

const reviewLog = (patch: Partial<RecordReviewLog> = {}): RecordReviewLog => ({
  id: "review-log-1",
  recordId: record.id,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  rating: "good",
  normalizedRating: "good",
  reviewKind: "overview",
  scheduler: "overview-v1",
  reviewedAt: "2026-07-02T00:00:00.000Z",
  previousEaseFactor: 2.5,
  nextEaseFactor: 2.6,
  previousRepetition: 1,
  nextRepetition: 2,
  previousIntervalDays: 1,
  nextIntervalDays: 6,
  ...patch,
});

describe("RecordCard", () => {
  it("keeps menu actions accessible without changing their scope", () => {
    const onOpen = vi.fn();
    const onAskAi = vi.fn();
    const onToggleFavorite = vi.fn();
    const onAddReview = vi.fn();
    render(<RecordCard menuActions record={record} onOpen={onOpen} onAskAi={onAskAi} onToggleFavorite={onToggleFavorite} onAddReview={onAddReview} />);
    fireEvent.click(screen.getByLabelText("记录操作 " + record.title));
    fireEvent.click(screen.getByRole("button", { name: "AI问答 " + record.date }));
    fireEvent.click(screen.getByRole("button", { name: "收藏记录" }));
    fireEvent.click(screen.getByRole("button", { name: "加入复习 " + record.title }));
    expect(onAskAi).toHaveBeenCalledWith(record.date);
    expect(onToggleFavorite).toHaveBeenCalledWith(true);
    expect(onAddReview).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("labels mastered re-enrollment as an action", () => {
    const onAddReview = vi.fn();
    render(<RecordCard record={record} onOpen={vi.fn()} reviewState={review({ status: "mastered" })} onAddReview={onAddReview} />);
    fireEvent.click(screen.getByRole("button", { name: "重新加入复习 " + record.title }));
    expect(onAddReview).toHaveBeenCalledTimes(1);
  });

  it("renders all record tags below the title", () => {
    render(<RecordCard record={{ ...record, tags: ["同步", "重点"] }} onOpen={vi.fn()} />);

    expect(screen.getByLabelText("日志标签：同步、重点")).toHaveTextContent("同步");
    expect(screen.getByLabelText("日志标签：同步、重点")).toHaveTextContent("重点");
  });

  it("orders the title and excerpt before supporting metadata", () => {
    render(<RecordCard record={record} onOpen={vi.fn()} />);

    const title = screen.getByText(record.title);
    const excerpt = screen.getByText("信号量机制实现");
    const metadata = screen.getByText(`${record.date} · ${record.subject}`);
    expect(title.compareDocumentPosition(excerpt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(excerpt.compareDocumentPosition(metadata) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps action buttons from opening the record", () => {
    const onOpen = vi.fn();
    const onAskAi = vi.fn();

    render(<RecordCard record={record} onOpen={onOpen} onAskAi={onAskAi} />);

    const aiButton = screen.getByTitle("AI问答");
    fireEvent.click(aiButton);

    expect(onAskAi).toHaveBeenCalledWith("2026-06-01");
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("renders an active review state as a non-action status", () => {
    render(
      <RecordCard
        record={record}
        onOpen={vi.fn()}
        onAddReview={vi.fn()}
        reviewState={review()}
      />,
    );

    expect(screen.queryByRole("button", { name: /待复习/ })).not.toBeInTheDocument();
    expect(screen.getByRole("status", { name: /待复习/ })).toBeInTheDocument();
  });

  it("does not mark a card as due after it has already been reviewed today", () => {
    render(
      <RecordCard
        record={record}
        onOpen={vi.fn()}
        onAddReview={vi.fn()}
        reviewState={review({ lastReviewDate: "2026-07-03" })}
      />,
    );

    expect(screen.getByRole("status", { name: /轻回看 07-02/ })).not.toHaveClass("due");
  });

  it("shows only an icon when the card has historical review evaluation", () => {
    render(
      <RecordCard
        record={record}
        onOpen={vi.fn()}
        reviewState={review()}
        reviewLogs={[reviewLog({ evaluationText: "历史评价正文" })]}
      />,
    );

    expect(screen.getByLabelText("有复习评价")).toBeInTheDocument();
    expect(screen.queryByText("历史评价正文")).not.toBeInTheDocument();
  });
});
