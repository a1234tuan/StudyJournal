import { Star } from "lucide-react";

import type { RecordBlock, RecordReviewLog, RecordReviewState } from "../types";
import { RecordCard } from "../components/RecordCard";
import { PageHeader } from "../components/ui";
import { getFavoriteRecords } from "../lib/journalSelectors";

interface FavoritesPageProps {
  records: RecordBlock[];
  onOpenRecord: (record: RecordBlock) => void;
  onAskAi?: (date: string) => void;
  onToggleFavorite: (record: RecordBlock, favorite: boolean) => void;
  reviewStatesByRecord?: Record<string, RecordReviewState>;
  reviewLogsByRecord?: Record<string, RecordReviewLog[]>;
  onAddToReview?: (recordId: string) => void;
}

export const FavoritesPage = ({
  records,
  onOpenRecord,
  onAskAi,
  onToggleFavorite,
  reviewStatesByRecord = {},
  reviewLogsByRecord = {},
  onAddToReview = () => undefined,
}: FavoritesPageProps) => {
  const favoriteRecords = getFavoriteRecords(records);

  return (
    <main className="page favorites-page primary-workspace-page">
      <PageHeader
        density="workspace"
        title="收藏夹"
        subtitle="这里收纳你标星的学习记录，按创建日期从新到旧排列。"
      />
      <div className="workspace-content">

      <section className="record-list">
        {favoriteRecords.length === 0 ? (
          <div className="empty-state">
            <Star size={24} />
            <h2>还没有收藏记录。</h2>
            <p>在任意日志卡片或记录详情页点击星标，它就会出现在这里。</p>
          </div>
        ) : (
          favoriteRecords.map((record) => (
            <RecordCard
              key={record.id}
              record={record}
              onOpen={onOpenRecord}
              onAskAi={onAskAi}
              onToggleFavorite={(nextFavorite) => onToggleFavorite(record, nextFavorite)}
              reviewState={reviewStatesByRecord[record.id]}
              reviewLogs={reviewLogsByRecord[record.id]}
              onAddReview={() => onAddToReview(record.id)}
            />
          ))
        )}
      </section>
      </div>
    </main>
  );
};
