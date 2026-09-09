import { BarChart3, BookOpen, BrainCircuit, ChevronRight, Download, FileText, Headphones, Layers3, LayoutTemplate, Mic2, Settings, Trash2 } from "lucide-react";

import type { AppSettings, AutoBackupSettings } from "../types";
import { createDefaultAiPresets } from "../db/defaults";
import { getCurrentAiProvider, normalizeAiConfig } from "../lib/aiProviders";
import { formatBytes } from "../lib/format";
import { ListRow, PageHeader } from "../components/ui";

interface MorePageProps {
  onOpenBackup: () => void;
  onOpenAi: () => void;
  onOpenOcrSettings: () => void;
  onOpenPodcasts: () => void;
  onOpenStats: () => void;
  onOpenSettings: () => void;
  onOpenTrash: () => void;
  onOpenRecordings?: () => void;
  onOpenTemplates: () => void;
  onOpenCategories: () => void;
  onOpenGuide: () => void;
  settings: AppSettings;
  autoBackupState?: AutoBackupSettings;
}

const formatBackupTime = (value?: string): string =>
  value ? new Date(value).toLocaleString([], { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "尚未备份";

const buildBackupMeta = (state?: AutoBackupSettings): string => {
  const enabled = state?.enabled ? "已开启" : "未开启";
  const time = formatBackupTime(state?.lastBackupAt);
  const size = state?.lastBackupSize ? ` · ${formatBytes(state.lastBackupSize)}` : "";
  return `${enabled} · ${time}${size}`;
};

const buildAiMeta = (settings: AppSettings): string => {
  const config = normalizeAiConfig(
    settings.ai,
    settings.ai?.presets?.length ? settings.ai.presets : createDefaultAiPresets(),
  );
  const currentProvider = getCurrentAiProvider(config);
  if (!currentProvider) {
    return "未配置供应商";
  }
  return currentProvider.model
    ? `${currentProvider.providerName} · ${currentProvider.model}`
    : currentProvider.providerName;
};

export const MorePage = ({
  onOpenBackup,
  onOpenAi,
  onOpenOcrSettings,
  onOpenPodcasts,
  onOpenStats,
  onOpenSettings,
  onOpenTrash,
  onOpenRecordings = () => undefined,
  onOpenTemplates,
  onOpenCategories,
  onOpenGuide,
  settings,
  autoBackupState,
}: MorePageProps) => (
  <main className="page more-page primary-workspace-page">
    <PageHeader
      eyebrow="More"
      title="更多"
      subtitle="备份、AI 工具和应用入口集中在这里，常用信息保持一屏可扫。"
      density="compact"
    />

    <section className="more-section more-hub-section">
      <h2>工具</h2>
      <div className="more-list">
        <ListRow
          className="more-summary-row"
          icon={<BrainCircuit size={19} />}
          title="AI 问答"
          meta={buildAiMeta(settings)}
          trailing={<ChevronRight size={17} />}
          onClick={onOpenAi}
        />
        <ListRow
          className="more-summary-row"
          icon={<Headphones size={19} />}
          title="知识播客"
          trailing={<ChevronRight size={17} />}
          onClick={onOpenPodcasts}
        />
        <ListRow
          className="more-summary-row"
          icon={<FileText size={19} />}
          title="OCR 设置"
          meta="PaddleOCR"
          trailing={<ChevronRight size={17} />}
          onClick={onOpenOcrSettings}
        />
      </div>
    </section>

    <section className="more-section more-hub-section">
      <h2>应用</h2>
      <div className="more-list">
        <ListRow icon={<Layers3 size={19} />} title="分类管理" trailing={<ChevronRight size={17} />} onClick={onOpenCategories} />
        <ListRow icon={<Mic2 size={19} />} title="录音库" trailing={<ChevronRight size={17} />} onClick={onOpenRecordings} />
        <ListRow icon={<LayoutTemplate size={19} />} title="模板" trailing={<ChevronRight size={17} />} onClick={onOpenTemplates} />
        <ListRow icon={<BarChart3 size={19} />} title="统计" trailing={<ChevronRight size={17} />} onClick={onOpenStats} />
      </div>
    </section>

    <section className="more-section more-hub-section">
      <h2>系统</h2>
      <div className="more-list">
        <ListRow
          className="more-summary-row"
          icon={<BookOpen size={19} />}
          title="使用教程"
          meta="Guide"
          trailing={<ChevronRight size={17} />}
          onClick={onOpenGuide}
        />
        <ListRow
          className="more-summary-row"
          icon={<Download size={19} />}
          title="备份与恢复"
          meta={buildBackupMeta(autoBackupState)}
          trailing={<ChevronRight size={17} />}
          onClick={onOpenBackup}
        />
        <ListRow icon={<Trash2 size={19} />} title="回收站" trailing={<ChevronRight size={17} />} onClick={onOpenTrash} />
        <ListRow icon={<Settings size={19} />} title="设置" trailing={<ChevronRight size={17} />} onClick={onOpenSettings} />
      </div>
    </section>
  </main>
);
