import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";

import type { Asset, Block, DayEntry, SearchResult } from "../types";
import { searchAllAsync } from "../lib/search";
import { isDesktopPlatform } from "../lib/platform";
import { PageHeader, WorkspaceBackButton } from "../components/ui";

interface SearchPageProps {
  entries: DayEntry[];
  blocks: Block[];
  assets: Asset[];
  query: string;
  onQueryChange: (query: string) => void;
  onBack?: () => void;
  onOpenRecord?: (recordId: string, assetId?: string) => void;
}

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_RESULT_LIMIT = 200;

export const SearchPage = ({ entries, blocks, assets, query, onQueryChange, onBack, onOpenRecord }: SearchPageProps) => {
  const desktop = isDesktopPlatform();
  const [inputValue, setInputValue] = useState(query);
  const composingRef = useRef(false);
  const [deferredQuery, setDeferredQuery] = useState(query);
  const [rawResults, setRawResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (!query.trim()) {
      setDeferredQuery("");
      return undefined;
    }
    const timer = window.setTimeout(() => setDeferredQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!desktop || composingRef.current) {
      return;
    }
    setInputValue(query);
  }, [desktop, query]);

  useEffect(() => {
    const controller = new AbortController();
    if (!deferredQuery.trim()) {
      setRawResults([]);
      setSearching(false);
      return () => controller.abort();
    }
    setSearching(true);
    void searchAllAsync(deferredQuery, entries, blocks, assets, SEARCH_RESULT_LIMIT + 1, controller.signal)
      .then((nextResults) => {
        if (!controller.signal.aborted) {
          setRawResults(nextResults);
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        throw error;
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setSearching(false);
        }
      });
    return () => controller.abort();
  }, [assets, blocks, deferredQuery, entries]);

  const results = rawResults.slice(0, SEARCH_RESULT_LIMIT);
  const hasMoreResults = rawResults.length > SEARCH_RESULT_LIMIT;

  return (
    <main className="page search-page primary-workspace-page">
      <PageHeader title="全文搜索" density="workspace" back={onBack && <WorkspaceBackButton onClick={onBack} />} />
      <div className="workspace-content">
      <label className="search-box">
        <Search size={20} />
        <input
          value={desktop ? inputValue : query}
          onCompositionStart={() => {
            if (desktop) {
              composingRef.current = true;
            }
          }}
          onCompositionEnd={(event) => {
            if (!desktop) {
              return;
            }
            composingRef.current = false;
            const nextValue = event.currentTarget.value;
            setInputValue(nextValue);
            onQueryChange(nextValue);
          }}
          onChange={(event) => {
            const nextValue = event.target.value;
            if (!desktop) {
              onQueryChange(nextValue);
              return;
            }
            setInputValue(nextValue);
            if (!(event.nativeEvent as InputEvent).isComposing && !composingRef.current) {
              onQueryChange(nextValue);
            }
          }}
          placeholder="搜索中值定理、页面置换、录音标题、PDF 文件名..."
        />
      </label>
      <section className="search-results">
        {searching && <p className="status-message">正在搜索…</p>}
        {hasMoreResults && (
          <p className="status-message">结果较多，仅显示前 {SEARCH_RESULT_LIMIT} 条，请缩小关键词。</p>
        )}
        {results.map((result) => (
          <button
            key={`${result.type}-${result.id}`}
            type="button"
            className="search-result"
            onClick={() => {
              if (result.recordId) {
                onOpenRecord?.(result.recordId, result.assetId);
              }
            }}
          >
            <span>{result.type}</span>
            <h3>{result.title}</h3>
            <p>{result.excerpt}</p>
            <div className="tag-row">
              {result.matchSource === "assetOcr" && <small>图片文字</small>}
              {result.matchSource === "assetMeta" && <small>资源标题</small>}
              {result.tags.map((tag) => (
                <small key={tag}>#{tag}</small>
              ))}
            </div>
          </button>
        ))}
        {query && results.length === 0 && (
          <div className="empty-state">
            <h2>没搜到。</h2>
            <p>换一个更短的关键词试试。</p>
          </div>
        )}
      </section>
      </div>
    </main>
  );
};
