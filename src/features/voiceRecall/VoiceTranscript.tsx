import { useEffect, useRef, useState, type ReactNode } from "react";
import type { VoiceRecallTurnLocal } from "./localTypes";

export const VoiceTranscript = ({ turns, revision, children, onReplayAssistant, replayingTurnId }: {
  turns: readonly VoiceRecallTurnLocal[];
  revision: string;
  children: ReactNode;
  onReplayAssistant?: (turn: VoiceRecallTurnLocal) => void;
  replayingTurnId?: string;
}) => {
  const container = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    if (following.current) element.scrollTop = element.scrollHeight;
    else setUnread(true);
  }, [turns, revision]);
  return <div className="vr-transcript-region">
    <div className="vr-transcript-scroll" ref={container} role="log" aria-label="本次通话字幕" aria-live="off" tabIndex={0} onScroll={() => {
      const element = container.current;
      if (!element) return;
      following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 48;
      if (following.current) setUnread(false);
    }}>
      {turns.map((turn) => <article key={turn.id} className="vr-transcript-turn">
        <p className="vr-user-turn"><span>你</span>{turn.confirmedText ?? turn.providerFinalText}</p>
        {onReplayAssistant && turn.teacherText.trim() ? <button type="button" className={`vr-assistant-turn vr-assistant-replay ${replayingTurnId === turn.id ? "is-replaying" : ""}`} disabled={Boolean(replayingTurnId)} aria-label={replayingTurnId === turn.id ? "正在重新播放学习助教回复" : "再次播放学习助教回复"} title="点击再次播放" onClick={() => onReplayAssistant(turn)}><span>{replayingTurnId === turn.id ? "学习助教 · 正在播放" : "学习助教 · 点击重播"}</span>{replayingTurnId === turn.id ? "正在重新播放…" : turn.teacherText}</button> : <p className="vr-assistant-turn"><span>学习助教</span>{turn.teacherText}</p>}
        {turn.status !== "completed" && <small>{turn.status === "cancelled" ? "已取消" : "本轮未完成"}</small>}
      </article>)}
      {children}
    </div>
    {unread && <button type="button" className="vr-new-messages" onClick={() => { following.current = true; setUnread(false); if (container.current) container.current.scrollTop = container.current.scrollHeight; }}>有新消息 · 回到底部</button>}
  </div>;
};
