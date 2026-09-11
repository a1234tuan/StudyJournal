import { BrainCircuit, FileText, MessageSquare, RefreshCw, Star } from "lucide-react";
import { useMemo } from "react";

import type { RecordBlock, RecordReviewLog, RecordReviewState } from "../types";
import { todayISO } from "../lib/date";
import { isReviewDueOn, reviewKindLabel } from "../lib/reviewScheduler";
import { RecordTagChips } from "./RecordTagChips";
import { recordToPlainText } from "../lib/recordContent";

interface RecordCardProps {
  record: RecordBlock;
  onOpen: (record: RecordBlock) => void;
  onAskAi?: (date: string) => void;
  onToggleFavorite?: (favorite: boolean) => void;
  reviewState?: RecordReviewState;
  reviewLogs?: RecordReviewLog[];
  onAddReview?: () => void;
  onEvaluate?: () => void;
}

const reviewLabel = (review?: RecordReviewState): string => {
  if (!review || review.status === "removed") return "加入复习";
  if (review.status === "mastered") return "已掌握";
  if (isReviewDueOn(review, todayISO())) return "待复习";
  return review.nextReviewDate ? `${reviewKindLabel(review.reviewKind)} ${review.nextReviewDate.slice(5)}` : reviewKindLabel(review.reviewKind);
};

const compactReviewLabel = (review?: RecordReviewState): string => {
  if (!review || review.status === "removed") return "加入";
  if (review.status === "mastered") return "掌握";
  if (isReviewDueOn(review, todayISO())) return "复习";
  return review.reviewKind === "memory" ? "记忆" : "回看";
};

export const RecordCard = ({ record, onOpen, onAskAi, onToggleFavorite, reviewState, reviewLogs = [], onAddReview, onEvaluate }: RecordCardProps) => {
  const canAddReview = onAddReview && (!reviewState || reviewState.status === "removed" || reviewState.status === "mastered");
  const reviewActive = reviewState?.status === "active";
  const reviewDue = isReviewDueOn(reviewState, todayISO());
  const hasReviewEvaluation = reviewLogs.some((log) => Boolean(log.evaluationText?.trim()));
  const excerpt = useMemo(() => recordToPlainText(record).replace(/\s+/g, " ").trim(), [record]);

  return (
    <article className="record-card">
      <button type="button" className="record-card-main" onClick={() => onOpen(record)}>
        <span className="record-card-icon">
          <FileText size={18} />
        </span>
        <div className="record-card-copy">
          <strong>{record.title}</strong>
          {excerpt && <p className="record-card-excerpt">{excerpt}</p>}
          <div className="record-card-supporting">
            <small className="record-card-meta">{record.date} · {record.subject}</small>
            <RecordTagChips subject={record.subject} tags={record.tags} />
          </div>
        </div>
      </button>
      <div className="record-card-actions" aria-label="记录操作">
        {onAskAi && (
          <button
            type="button"
            className="record-ai-button"
            onClick={() => onAskAi(record.date)}
            aria-label={`AI问答 ${record.date}`}
            title="AI问答"
          >
            <BrainCircuit size={16} />
          </button>
        )}
        {onAddReview && (
          <button
            type="button"
            className={`record-review-button ${reviewActive ? "active" : ""} ${reviewDue ? "due" : ""} ${reviewState?.status === "mastered" ? "mastered" : ""}`}
            onClick={() => {
              if (canAddReview) onAddReview();
            }}
            aria-label={`${reviewLabel(reviewState)} ${record.title}`}
            title={reviewLabel(reviewState)}
          >
            <RefreshCw size={15} />
            <span>{compactReviewLabel(reviewState)}</span>
          </button>
        )}
        {onToggleFavorite && (
          <button
            type="button"
            className={`record-favorite-button ${record.favorite ? "active" : ""}`}
            onClick={() => onToggleFavorite(!record.favorite)}
            aria-label={record.favorite ? "取消收藏" : "收藏记录"}
            title={record.favorite ? "取消收藏" : "收藏记录"}
          >
            <Star size={16} fill={record.favorite ? "currentColor" : "none"} />
          </button>
        )}
        {onEvaluate && (
          <button
            type="button"
            className={`record-evaluate-button ${hasReviewEvaluation ? "active" : ""}`}
            onClick={() => onEvaluate()}
            aria-label={hasReviewEvaluation ? "查看复习评价" : "评论评价"}
            title="评论评价"
          >
            <MessageSquare size={15} />
          </button>
        )}
        {!onEvaluate && hasReviewEvaluation && (
          <span className="record-evaluation-indicator" title="有复习评价" aria-label="有复习评价" role="img">
            <MessageSquare size={15} />
          </span>
        )}
      </div>
    </article>
  );
};
