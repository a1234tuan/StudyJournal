import { useMemo } from "react";

import { RichTextEditor } from "../../components/RichTextEditor";
import type { RecordBlock } from "../../types";
import { extractDecisionBlocks } from "./decisionBlockContent";

interface DecisionBlockRichPreviewProps {
  record?: RecordBlock;
  decisionBlockId: string;
  referenceRecords?: readonly RecordBlock[];
  className?: string;
  ariaLabel?: string;
}

const ignoreReadOnlyChange = () => undefined;

/**
 * Render the canonical rich content of one decision block.
 *
 * Formula text lives in custom-node attributes, so DOM `textContent` is a
 * lossy projection here. Reusing the record viewer also keeps collapse,
 * highlight and structure nodes on the same rendering path as the journal.
 */
export const DecisionBlockRichPreview = ({
  record,
  decisionBlockId,
  referenceRecords = [],
  className,
  ariaLabel = "复习重点原文",
}: DecisionBlockRichPreviewProps) => {
  const contentHtml = useMemo(() => {
    if (!record) return undefined;
    return extractDecisionBlocks(record.contentHtml, record.updatedAt)
      .find((block) => block.decisionBlockId === decisionBlockId)
      ?.innerHtml;
  }, [decisionBlockId, record]);

  if (!record) return <p className={className}>来源记录不可用</p>;
  if (!contentHtml) return <p className={className}>来源片段不可用</p>;

  return (
    <div className={className} aria-label={ariaLabel}>
      <RichTextEditor
        value={contentHtml}
        onChange={ignoreReadOnlyChange}
        placeholder=""
        readOnly
        currentRecordId={record.id}
        referenceRecords={referenceRecords}
      />
    </div>
  );
};
