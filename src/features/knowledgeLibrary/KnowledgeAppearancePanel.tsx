import { Bold, Palette, X } from "lucide-react";
import { COLOR_LABELS, DEFAULT_NODE_APPEARANCE, LINE_LABELS, NODE_COLORS, STRUCTURE_LABELS, type MapAppearance, type NodeAppearance } from "./appearance";

export function MapAppearancePicker({ value, disabled = false, onChange }: { value: MapAppearance; disabled?: boolean; onChange: (value: MapAppearance) => void }) {
  return <div className="knowledge-map-picker">
    <fieldset disabled={disabled}><legend>导图结构</legend><div className="knowledge-structure-options">{(Object.keys(STRUCTURE_LABELS) as Array<MapAppearance["structure"]>).map(structure => <button type="button" key={structure} aria-pressed={value.structure === structure} onClick={() => onChange({ ...value, structure })}>
      <svg aria-hidden="true" viewBox="0 0 80 48"><path d={structure === "radial" ? "M40 24 H12 M40 24 H68 M40 24 V6 M40 24 V42" : structure === "logic" ? "M12 24 H36 V10 H65 M36 24 H65 M36 24 V38 H65" : "M40 24 H24 V10 H8 M24 24 V38 H8 M40 24 H56 V10 H72 M56 24 V38 H72"} /><rect x={structure === "logic" ? 3 : 31} y="18" width="18" height="12" rx="3" /></svg>
      <span>{STRUCTURE_LABELS[structure]}</span></button>)}</div></fieldset>
    <label className="knowledge-line-picker">分支线型<select aria-label="分支线型" disabled={disabled} value={value.line} onChange={event => onChange({ ...value, line: event.target.value as MapAppearance["line"] })}>{(Object.keys(LINE_LABELS) as Array<MapAppearance["line"]>).map(line => <option key={line} value={line}>{LINE_LABELS[line]}</option>)}</select></label>
  </div>;
}
interface Props { title?: string; appearance?: NodeAppearance; map: MapAppearance; disabled: boolean; editing: boolean; onChange: (value: NodeAppearance) => void; onMapChange: (value: MapAppearance) => void; onClose: () => void; onDetails?: () => void }
export function KnowledgeAppearancePanel({ title, appearance, map, disabled, editing, onChange, onMapChange, onClose, onDetails }: Props) {
  return <aside className="knowledge-appearance-panel" aria-label="导图样式">
    <header><span><Palette size={16} />{appearance ? "节点样式" : "导图样式"}</span><button type="button" className="knowledge-icon" aria-label="关闭样式面板" onClick={onClose}><X size={18} /></button></header>
    <div className="knowledge-appearance-body">
      {appearance && <><p className="knowledge-appearance-title" title={title}>{title || "新节点"}</p><fieldset disabled={disabled}><legend>文字</legend><button type="button" className="knowledge-bold-button" aria-label="加粗" aria-pressed={appearance.bold} onClick={() => onChange({ ...appearance, bold: !appearance.bold })}><Bold size={16} />加粗</button><div role="group" aria-label="文字颜色" className="knowledge-color-options">{NODE_COLORS.map(color => <button type="button" key={color} data-swatch={color} aria-label={"文字" + COLOR_LABELS[color]} aria-pressed={appearance.color === color} onClick={() => onChange({ ...appearance, color })}><span aria-hidden="true">A</span></button>)}</div></fieldset>
      <fieldset disabled={disabled}><legend>背景高亮</legend><div role="group" aria-label="背景高亮" className="knowledge-color-options">{NODE_COLORS.map(background => <button type="button" key={background} data-swatch={background} aria-label={"背景" + COLOR_LABELS[background]} aria-pressed={appearance.background === background} onClick={() => onChange({ ...appearance, background })}><span aria-hidden="true">{background === "default" ? "×" : "●"}</span></button>)}</div></fieldset>
      <button type="button" disabled={disabled} onClick={() => onChange({ ...DEFAULT_NODE_APPEARANCE })}>恢复节点默认样式</button>
      {editing && <p className="knowledge-appearance-hint">随节点标题一起保存；取消编辑将放弃本次样式调整。</p>}
      {onDetails && !editing && <button type="button" onClick={onDetails}>节点说明与关联日志</button>}</>}
      <MapAppearancePicker value={map} disabled={disabled || editing} onChange={onMapChange} />
    </div>
  </aside>;
}
