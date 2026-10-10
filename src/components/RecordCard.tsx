import { BrainCircuit, FileText, MessageSquare, MoreHorizontal, RefreshCw, Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { RecordBlock, RecordReviewLog, RecordReviewState } from "../types";
import { todayISO } from "../lib/date";
import { isReviewDueOn, reviewKindLabel } from "../lib/reviewScheduler";
import { RecordTagChips } from "./RecordTagChips";
import { recordToPlainText } from "../lib/recordContent";

interface RecordCardProps {
  record: RecordBlock;
  compact?: boolean;
  menuActions?: boolean;
  selected?: boolean;
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
  if (review.status === "mastered") return "重新加入复习";
  if (isReviewDueOn(review, todayISO())) return "待复习";
  return review.nextReviewDate ? `${reviewKindLabel(review.reviewKind)} ${review.nextReviewDate.slice(5)}` : reviewKindLabel(review.reviewKind);
};

const compactReviewLabel = (review?: RecordReviewState): string => {
  if (!review || review.status === "removed") return "加入";
  if (review.status === "mastered") return "重学";
  if (isReviewDueOn(review, todayISO())) return "复习";
  return review.reviewKind === "memory" ? "记忆" : "回看";
};

export const RecordCard = ({ record, compact = false, menuActions = false, selected = false, onOpen, onAskAi, onToggleFavorite, reviewState, reviewLogs = [], onAddReview, onEvaluate }: RecordCardProps) => {
  const canAddReview = onAddReview && (!reviewState || reviewState.status === "removed" || reviewState.status === "mastered");
  const reviewDue = isReviewDueOn(reviewState, todayISO());
  const hasReviewEvaluation = reviewLogs.some((log) => Boolean(log.evaluationText?.trim()));
  const excerpt = useMemo(() => recordToPlainText(record).replace(/\s+/g, " ").trim(), [record]);

  const cardRef = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => {
      const details = cardRef.current?.querySelector("details");
      if (details) details.open = false;
      setMenuOpen(false);
    };
    const onOutsideClick = (event: MouseEvent) => {
      if (!cardRef.current?.querySelector("details")?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
      cardRef.current?.querySelector("summary")?.focus();
    };
    document.addEventListener("click", onOutsideClick);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("click", onOutsideClick);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menuOpen]);

  const useMenu = compact || menuActions;
  const Actions = useMenu ? "details" : "div";
  return (
    <article ref={cardRef} data-record-id={record.id} className={`record-card${compact ? " record-card-index" : ""}${selected ? " selected" : ""}${useMenu ? " record-card-menu" : ""}`}>
      <button type="button" className="record-card-main" aria-current={selected ? "true" : undefined} title={record.title} onClick={() => onOpen(record)}>
        <span className="record-card-icon">
          <FileText size={18} />
        </span>
        <div className="record-card-copy">
          <strong>{record.title}</strong>
          {excerpt && <p className="record-card-excerpt">{excerpt}</p>}
          <div className="record-card-supporting">
            {compact && record.favorite && <Star size={12} fill="currentColor" aria-label="已收藏" />}
            <small className="record-card-meta">{record.date} · {record.subject}</small>
            <RecordTagChips subject={record.subject} tags={record.tags} />
          </div>
        </div>
      </button>
      <Actions className="record-card-actions" aria-label="记录操作" onToggle={(event) => setMenuOpen((event.currentTarget as HTMLDetailsElement).open === true)}>
        {useMenu && <summary aria-label={`记录操作 ${record.title}`} title="记录操作"><MoreHorizontal size={18} /></summary>}
        <div className="record-action-items">
        {onAskAi && (
          <button
            type="button"
            className="record-ai-button"
            onClick={() => onAskAi(record.date)}
            aria-label={`AI问答 ${record.date}`}
            title="AI问答"
          >
            <BrainCircuit size={16} />{useMenu && <span>AI问答</span>}
          </button>
        )}
        {onAddReview && (canAddReview ? (
          <button
            type="button"
            className={`record-review-button ${reviewState?.status === "mastered" ? "mastered" : ""}`}
            onClick={onAddReview}
            aria-label={`${reviewLabel(reviewState)} ${record.title}`}
            title={reviewLabel(reviewState)}
          >
            <RefreshCw size={15} />
            <span>{useMenu ? reviewLabel(reviewState) : compactReviewLabel(reviewState)}</span>
          </button>
        ) : (
          <span
            className={`record-review-status ${reviewDue ? "due" : ""}`}
            role="status"
            aria-label={`${reviewLabel(reviewState)} ${record.title}`}
            title={reviewLabel(reviewState)}
          >
            <RefreshCw size={15} />
            <span>{useMenu ? reviewLabel(reviewState) : compactReviewLabel(reviewState)}</span>
          </span>
        ))}
        {onToggleFavorite && (
          <button
            type="button"
            className={`record-favorite-button ${record.favorite ? "active" : ""}`}
            onClick={() => onToggleFavorite(!record.favorite)}
            aria-label={record.favorite ? "取消收藏" : "收藏记录"}
            title={record.favorite ? "取消收藏" : "收藏记录"}
          >
            <Star size={16} fill={record.favorite ? "currentColor" : "none"} />{useMenu && <span>{record.favorite ? "取消收藏" : "收藏记录"}</span>}
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
            <MessageSquare size={15} />{useMenu && <span>{hasReviewEvaluation ? "查看复习评价" : "评论评价"}</span>}
          </button>
        )}
        {!onEvaluate && hasReviewEvaluation && (
          <span className="record-evaluation-indicator" title="有复习评价" aria-label="有复习评价" role="img">
            <MessageSquare size={15} />
          </span>
        )}
        </div>
      </Actions>
    </article>
  );
};
