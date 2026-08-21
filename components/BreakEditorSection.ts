import { createElement } from "react";
import {
  addCorrectionBreak,
  updateCorrectionBreak,
  type CorrectionEditor,
} from "../lib/attendance-correction.ts";

type Props = {
  editor: CorrectionEditor;
  setEditor: (editor: CorrectionEditor) => void;
  breakMinutes: number;
  workMinutes: number | null;
  nightMinutes: number | null;
  hasIncompleteBreak: boolean;
  formatMinutes: (minutes: number) => string;
};

const inputStyle = { boxSizing: "border-box" as const, minHeight: 48, border: "1px solid #CBD5E1", borderRadius: 10, padding: "0 12px", width: "100%", fontSize: 16 };
const labelStyle = { display: "flex", flexDirection: "column" as const, gap: 5, fontSize: 14, fontWeight: 700 };

export function BreakEditorSection(props: Props) {
  const activeBreaks = props.editor.breaks.filter((item) => !item.isDeleted);
  const rows = props.editor.breaks.map((item, index) => item.isDeleted ? null : createElement(
    "div",
    { key: item.key, className: "correction-break-row", style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) auto", gap: 12, alignItems: "end", marginTop: 12 } },
    createElement("label", { style: labelStyle }, "休憩開始日時", createElement("input", {
      "aria-label": `休憩${index + 1}開始日時`, type: "datetime-local", value: item.start, style: inputStyle,
      onChange: (event: { target: { value: string } }) => props.setEditor(updateCorrectionBreak(props.editor, index, { start: event.target.value })),
    })),
    createElement("label", { style: labelStyle }, "休憩終了日時", createElement("input", {
      "aria-label": `休憩${index + 1}終了日時`, type: "datetime-local", value: item.end, style: inputStyle,
      onChange: (event: { target: { value: string } }) => props.setEditor(updateCorrectionBreak(props.editor, index, { end: event.target.value })),
    })),
    createElement("button", {
      type: "button",
      onClick: () => props.setEditor(updateCorrectionBreak(props.editor, index, { isDeleted: true })),
      style: { minHeight: 38, border: "1px solid #FCA5A5", borderRadius: 8, background: "#FEF2F2", color: "#B91C1C", fontWeight: 700 },
    }, "削除"),
  ));

  return createElement(
    "section",
    { "data-testid": "break-editor-section", style: { gridColumn: "1 / -1", minWidth: 0, border: "1px solid #BDEBFA", background: "#F8FDFF", borderRadius: 12, padding: 16 } },
    createElement("div", { className: "correction-break-header", style: { display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 14, alignItems: "center" } },
      createElement("h4", { style: { margin: 0, fontSize: 18 } }, "休憩"),
      activeBreaks.length === 0
        ? createElement("p", { style: { margin: 0, color: "#64748B", fontSize: 14 } }, "登録された休憩はありません")
        : createElement("span", null),
      createElement("button", {
        type: "button",
        onClick: () => props.setEditor(addCorrectionBreak(props.editor, `new-${Date.now()}-${props.editor.breaks.length}`)),
        style: { minHeight: 34, border: "1px solid #53C1ED", borderRadius: 8, background: "#ffffff", color: "#168AB5", padding: "0 12px", fontSize: 14, fontWeight: 800 },
      }, "＋休憩を追加"),
    ),
    ...rows,
    props.hasIncompleteBreak
      ? createElement("p", { style: { margin: "10px 0 0", borderRadius: 8, background: "#FEF2F2", color: "#991B1B", padding: 10, fontWeight: 700 } }, "休憩打刻が未完了です。空欄を補完するか、不要な休憩を削除してください。")
      : null,
    createElement("div", { className: "correction-break-summary", style: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 12, marginTop: 12, paddingTop: 12, borderTop: "1px solid #D8EEF7", fontSize: 14 } },
      createElement("div", null, `休憩合計 ${props.formatMinutes(props.breakMinutes)}`),
      createElement("div", null, `労働時間 ${props.workMinutes == null ? "未確定" : props.formatMinutes(props.workMinutes)}`),
      createElement("div", null, `深夜時間 ${props.nightMinutes == null ? "未確定" : props.formatMinutes(props.nightMinutes)}`),
    ),
  );
}
