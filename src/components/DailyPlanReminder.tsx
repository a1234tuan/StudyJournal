import { useEffect, useRef } from "react";
import { ArrowUpRight, Check, X } from "lucide-react";
import { formatChineseDate } from "../lib/date";
import "../styles/daily-plan-reminder.css";

interface Props {
  open: boolean;
  date: string;
  planCount: number;
  onDismiss: () => void;
  onOpenPlan: () => void;
}

export const DailyPlanReminder = ({ open, date, planCount, onDismiss, onOpenPlan }: Props) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const action = useRef<HTMLButtonElement>(null);
  const planned = planCount > 0;
  useEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    element.showModal();
    action.current?.focus({ preventScroll: true });
    return () => { element.close(); if (focused?.isConnected) focused.focus({ preventScroll: true }); };
  }, [open]);

  return <dialog ref={dialog} className="daily-plan-reminder" aria-labelledby="daily-plan-reminder-title" aria-describedby="daily-plan-reminder-description" onCancel={event => { event.preventDefault(); onDismiss(); }}>
    <button className="daily-plan-reminder-close" type="button" aria-label="关闭计划提醒" onClick={onDismiss}><X size={19} /></button>
    <div className="daily-plan-reminder-date"><span />{formatChineseDate(date)}</div>
    <div className="daily-plan-reminder-art" aria-hidden="true">
      <div className="daily-plan-reminder-orbit" />
      <div className="daily-plan-reminder-paper">
        <div className="daily-plan-reminder-binding"><i /><i /></div>
        <div className="daily-plan-reminder-paper-heading"><span>TODAY</span><strong>{date.slice(-2)}</strong></div>
        <div className="daily-plan-reminder-line"><span><Check size={13} /></span><i /></div>
        <div className="daily-plan-reminder-line"><span /><i /></div>
        <div className="daily-plan-reminder-line"><span /><i /></div>
      </div>
      <div className="daily-plan-reminder-note">一步一步，<br />靠近目标。</div>
    </div>
    <p className="daily-plan-reminder-eyebrow">{planned ? "让计划陪你开始" : "给今天一点方向"}</p>
    <h2 id="daily-plan-reminder-title">{planned ? "今天的计划，已经就绪" : "为今天定个小目标"}</h2>
    <p id="daily-plan-reminder-description">{planned ? <>今天已安排 <strong>{planCount}</strong> 项计划。看一眼安排，再从一件小事开始。</> : "先安排一两件重要的事，让今天的学习更有方向。"}</p>
    <div className="daily-plan-reminder-actions">
      <button ref={action} type="button" className="primary-button" onClick={() => { onDismiss(); onOpenPlan(); }}>{planned ? "查看今日计划" : "去制定计划"}<ArrowUpRight size={18} /></button>
      <button type="button" className="daily-plan-reminder-later" onClick={onDismiss}>{planned ? "直接开始" : "暂不制定"}</button>
    </div>
    <p className="daily-plan-reminder-footnote">今天不再提醒 · 随时可从首页进入计划</p>
  </dialog>;
};
