import { pendingReviewNavigation } from "../reviewSession/navigationGuard";
import { formatActionableError } from "../../lib/uiError";
import { cloneElement, useEffect, useRef, useState, type ReactElement } from "react";
import { Check, ChevronRight, Circle, MoreHorizontal } from "lucide-react";
import { arrangedItemStatus, arrangedRatings } from "./domain";
import { arrangedReviewRepository, useArrangedReviews } from "./repository";
import type { ReviewPageProps } from "../../pages/ReviewPage";

import { DueReviewBoard } from "./DueReviewBoard";
import { ReviewBoardDialog } from "./ReviewBoardDialog";
import "./arrangedReview.css";
const key = "study-journal-arranged-navigation";
export interface ReviewHubRoute { mode: "ordinary" | "arranged"; roundId?: string; recordId?: string }
export const loadReviewHubRoute = (): ReviewHubRoute => { try { const value = JSON.parse(localStorage.getItem(key) ?? "null"); return value?.mode === "arranged" ? value : { mode: "ordinary" }; } catch { return { mode: "ordinary" }; } };
export function ReviewHub({ children, route, onRoute: commitRoute }: { children: ReactElement<ReviewPageProps>; route: ReviewHubRoute; onRoute: (route: ReviewHubRoute) => void }) {
  const { rounds, events, error: loadError } = useArrangedReviews();
  const navigationAttempt = useRef(0);
  const onRoute = (next: ReviewHubRoute) => { const attempt = ++navigationAttempt.current; const pending = pendingReviewNavigation(); if (pending) void pending.then(() => { if (navigationAttempt.current === attempt) commitRoute(next); }).catch(() => undefined); else commitRoute(next); };
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const scroll = useRef<Record<string, number>>({});
  const listRef = useRef<HTMLElement>(null);
  const [boardOpen, setBoardOpen] = useState(route.mode === "arranged" && !route.recordId);
  const [ordinaryFromBoard, setOrdinaryFromBoard] = useState(false);
  const round = rounds.find(item => item.id === route.roundId && !item.deletedAt);
  const record = children.props.records.find(item => item.id === route.recordId);
  const current = round && record && round.items.some(item => item.recordId === record.id) ? arrangedItemStatus(events, round.id, record.id) : undefined;
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(route)); } catch {} }, [route]);
  useEffect(() => {
    if (route.mode === "arranged" && !route.recordId) setBoardOpen(true);
    else if (route.recordId) setBoardOpen(false);
  }, [route.mode, route.roundId, route.recordId]);
  useEffect(() => { if (boardOpen && listRef.current) listRef.current.scrollTop = scroll.current[route.roundId ?? "rounds"] ?? 0; }, [boardOpen, route.roundId]);
  const back = () => { if (!route.recordId && !route.roundId) setBoardOpen(false); else onRoute({ mode: "arranged", roundId: route.recordId ? route.roundId : undefined }); };
  useEffect(() => { if (route.mode !== "arranged" || (!route.recordId && !boardOpen)) return; const handler = (event: Event) => { event.preventDefault(); back(); }; window.addEventListener("arranged-review-back", handler); return () => window.removeEventListener("arranged-review-back", handler); }, [route, boardOpen]);
  const action = async (work: () => Promise<unknown>) => { setBusy(true); setError(""); try { await work(); } catch (reason) { setError(formatActionableError(reason, "review-feedback")); } finally { setBusy(false); } };
  const nav = <nav className="arranged-mode-nav" aria-label="看板内容"><button aria-pressed={route.mode === "ordinary"} onClick={() => onRoute({ ...route, mode: "ordinary" })}>待复习</button><button aria-pressed={route.mode === "arranged"} onClick={() => onRoute({ ...route, mode: "arranged" })}>已安排</button></nav>;
  const card = route.mode === "arranged" && round && record && current ? cloneElement(children, { key: round.id + record.id, mode: "queue", currentRecordId: record.id, queueIds: [record.id], reviewRuntime: undefined, onReviewRuntimeChange: undefined, onReviewProgressChange: undefined, standalone: { roundId: round.id, title: round.title, recordId: record.id, readOnly: Boolean(round.endedAt || current.rating || current.conflict), rating: current.rating, index: round.items.findIndex(item => item.recordId === record.id) + 1, total: round.items.length, completed: round.items.filter(item => Boolean(arrangedItemStatus(events, round.id, item.recordId).rating)).length, onUndo: current.rating && !round.endedAt ? async () => { await pendingReviewNavigation(); await arrangedReviewRepository.rate(round.id, record.id, null, record.updatedAt, current.heads.map(event => event.id)); onRoute({ mode: "arranged", roundId: round.id }); } : undefined, onBack: () => onRoute({ mode: "arranged", roundId: round.id }), onRate: async rating => { await pendingReviewNavigation(); await arrangedReviewRepository.rate(round.id, record.id, rating, record.updatedAt, current.heads.map(event => event.id)); onRoute({ mode: "arranged", roundId: round.id }); } }, coachOpen: false }) : cloneElement(children, { onOpenReviewBoard: () => setBoardOpen(true), ...(ordinaryFromBoard ? { reviewExitLabel: "返回看板", onExitReviewSession: () => setBoardOpen(true) } : {}) });
  const startOrdinary = (ids: string[]) => {
    children.props.onReviewRuntimeChange?.(state => ({ ...state, showAllDue: true, selectedQueueIds: ids, sessionRecordIds: ids, ratedRecordIds: [], undoHistory: [] }));
    children.props.onQueueChange(ids);
    children.props.onCurrentRecordChange(ids[0]);
    children.props.onReviewProgressChange?.({ total: ids.length, completed: 0 });
    children.props.onModeChange("queue");
    setOrdinaryFromBoard(true);
    setBoardOpen(false);
    onRoute({ mode: "ordinary" });
  };
  const completed = round?.items.filter(item => Boolean(arrangedItemStatus(events, round.id, item.recordId).rating)).length ?? 0;
  return <>{card}<ReviewBoardDialog open={boardOpen} onClose={() => { if (!busy) { setBoardOpen(false); if (route.mode === "arranged" && !route.recordId) onRoute({ ...route, mode: "ordinary" }); } }}>{nav}<div className="review-board-panel" hidden={route.mode !== "ordinary"}><DueReviewBoard records={children.props.records} due={children.props.dueReviews} onStart={startOrdinary} /></div><section ref={listRef} onScroll={event => { scroll.current[route.roundId ?? "rounds"] = event.currentTarget.scrollTop; }} hidden={route.mode !== "arranged"} className="arranged-workspace review-board-rounds"><header className="arranged-header">{round && <button className="secondary-button" onClick={back}>返回列表</button>}<h1>{round?.title ?? "已安排的复习"}</h1></header>{(error || loadError) && <p role="alert">{error || loadError}</p>}
    {round ? <><div className="arranged-summary"><strong>{completed}/{round.items.length} 已完成</strong><span>{round.endedAt ? "已结束" : completed === round.items.length ? "本轮已完成" : "进行中"}</span></div>
      <div className="arranged-list">{round.items.map(item => { const status = arrangedItemStatus(events, round.id, item.recordId); const available = children.props.records.find(record => record.id === item.recordId); const feedback = children.props.decisionBlockFeedback?.filter(feedback => !feedback.deletedAt && feedback.recordId === item.recordId && feedback.originRoundId === round.id) ?? []; const failed = feedback.some(feedback => children.props.feedbackInterpretations?.some(value => value.feedbackId === feedback.id && value.status === "failed")); const running = feedback.some(feedback => children.props.feedbackInterpretations?.some(value => value.feedbackId === feedback.id && ["running", "pending"].includes(value.status))); const analyzed = feedback.some(feedback => children.props.feedbackInterpretations?.some(value => value.feedbackId === feedback.id && value.status === "succeeded")); return <div key={item.recordId}><button className="arranged-row" disabled={!available} onClick={() => { onRoute({ mode: "arranged", roundId: round.id, recordId: item.recordId }); }}><span className={"arranged-check " + (status.rating ? "complete" : "")}>{status.rating ? <Check size={18} /> : <Circle size={14} />}</span><span><strong>{item.title}</strong><small>{item.source}</small>{!available && <small>日志不可用</small>}{available && status.rating && status.heads[0]?.contentRevision !== available.updatedAt && <small>内容已更新</small>}{feedback.length > 0 && <small>{failed ? "分析失败 · 可重试" : running ? "分析未完成 · 可继续" : analyzed ? "可查看分析" : "待分析"}</small>}</span><span>{status.conflict ? "评价冲突" : arrangedRatings.find(value => value.value === status.rating)?.label ?? "未完成"}</span><ChevronRight size={17} /></button>{status.conflict && <div className="arranged-actions" role="group" aria-label={item.title + " 解决评价冲突"}>{status.heads.map(head => <button disabled={busy || !available || Boolean(round.endedAt)} key={head.id} onClick={() => void action(() => arrangedReviewRepository.rate(round.id, item.recordId, head.rating, available!.updatedAt, status.heads.map(event => event.id)))}>{arrangedRatings.find(value => value.value === head.rating)?.label ?? "未完成"} · {head.createdAt.slice(0, 16)}</button>)}</div>}</div>; })}</div>
      <div className="arranged-summary">{arrangedRatings.map(value => <span key={value.value}>{value.label} {round.items.filter(item => arrangedItemStatus(events, round.id, item.recordId).rating === value.value).length}</span>)}</div>
      <div className="arranged-round-controls">
        <button className="secondary-button" disabled={busy} onClick={() => void action(async () => { const next = await arrangedReviewRepository.create(round.title, round.items.filter(item => children.props.records.some(record => record.id === item.recordId))); onRoute({ mode: "arranged", roundId: next.id }); })}>再练一轮</button>
        <details className="arranged-round-more">
          <summary aria-label="更多本轮操作" title="更多本轮操作"><MoreHorizontal size={19} /></summary>
          <div className="arranged-round-menu">
            <button disabled={busy || !round.items.some(item => ["forgot", "fuzzy"].includes(arrangedItemStatus(events, round.id, item.recordId).rating ?? ""))} onClick={() => void action(async () => { const next = await arrangedReviewRepository.create(round.title, round.items.filter(item => ["forgot", "fuzzy"].includes(arrangedItemStatus(events, round.id, item.recordId).rating ?? ""))); onRoute({ mode: "arranged", roundId: next.id }); })}>薄弱项再练</button>
            {!round.endedAt && completed < round.items.length && <button disabled={busy} onClick={() => { if (window.confirm("提前结束本轮？已完成评价将保留。")) void action(() => arrangedReviewRepository.close(round)); }}>提前结束</button>}
            <button className="danger" disabled={busy} onClick={() => { if (window.confirm("删除本轮？已提交的学习助教反馈和训练任务将保留。")) void action(async () => { await arrangedReviewRepository.close(round, true); onRoute({ mode: "arranged" }); }); }}>删除本轮</button>
          </div>
        </details>
      </div>
    </> : <div className="arranged-list">{rounds.filter(item => !item.deletedAt).sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(item => <button key={item.id} className="arranged-row" onClick={() => onRoute({ mode: "arranged", roundId: item.id })}><span className="arranged-check"><Circle size={16} /></span><span><strong>{item.title}</strong><small>{item.items.filter(value => arrangedItemStatus(events, item.id, value.recordId).rating).length}/{item.items.length} 已完成 · {item.endedAt ? "已结束" : "查看看板"}</small></span><ChevronRight size={18} /></button>)}{!rounds.some(item => !item.deletedAt) && <p>在知识库中选择节点或日志，安排复习。</p>}</div>}
  </section></ReviewBoardDialog></>;
}
