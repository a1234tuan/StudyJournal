import { useEffect, useState } from "react";
import { liveQuery } from "dexie";
import type { JournalTopic } from "../../lib/journalFilters";
import { currentKnowledgeOwner, knowledgeContextGeneration } from "./context";
import { knowledgeRepository } from "./runtime";
import { loadJournalTopics } from "./journalTopics";

const emptyTopics: JournalTopic[] = [];
export const useJournalTopics = () => {
  const [generation, setGeneration] = useState(knowledgeContextGeneration);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ generation: number; topics: JournalTopic[]; error: string }>();
  useEffect(() => {
    const changed = () => { setResult(undefined); setGeneration(knowledgeContextGeneration()); };
    window.addEventListener("knowledge-owner-changed", changed);
    return () => window.removeEventListener("knowledge-owner-changed", changed);
  }, []);
  useEffect(() => {
    let active = true;
    setResult(undefined);
    const subscription = liveQuery(() => loadJournalTopics(knowledgeRepository)).subscribe({
      next: topics => { if (active && generation === knowledgeContextGeneration()) setResult({ generation, topics, error: "" }); },
      error: () => { if (active && generation === knowledgeContextGeneration()) setResult({ generation, topics: emptyTopics, error: "专题读取失败，请重试。日志内容未受影响。" }); },
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, [generation, attempt]);
  const current = result?.generation === knowledgeContextGeneration() ? result : undefined;
  return { owner: currentKnowledgeOwner(), topics: current?.topics ?? emptyTopics, loading: !current, error: current?.error ?? "", retry: () => setAttempt(value => value + 1) };
};
