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

const inputStyle = { minHeight: 42, border: "1px solid #CBD5E1", borderRadius: 10, padding: "0 10px", width: "100%" };
const labelStyle = { display: "flex", flexDirection: "column" as const, gap: 5, fontSize: 12, fontWeight: 700 };

export function BreakEditorSection(props: Props) {
  const activeBreaks = props.editor.breaks.filter((item) => !item.isDeleted);
  const rows = props.editor.breaks.map((item, index) => item.isDeleted ? null : createElement(
    "div",
    { key: item.key, style: { display: "grid", gridTemplateColumns: "minmax(170px, 1fr) minmax(170px, 1fr) auto", gap: 8, alignItems: "end", marginBottom: 10 } },
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
    { "data-testid": "break-editor-section", style: { border: "2px solid #BDEBFA", background: "#F8FDFF", borderRadius: 12, padding: 14 } },
    createElement("h4", { style: { margin: "0 0 10px", fontSize: 16 } }, "休憩"),
    activeBreaks.length === 0
      ? createElement("p", { style: { margin: "0 0 10px", color: "#64748B", fontSize: 13 } }, "登録された休憩はありません")
      : null,
    ...rows,
    createElement("button", {
      type: "button",
      onClick: () => props.setEditor(addCorrectionBreak(props.editor, `new-${Date.now()}-${props.editor.breaks.length}`)),
      style: { minHeight: 42, border: "1px solid #53C1ED", borderRadius: 10, background: "#ffffff", color: "#168AB5", padding: "0 14px", fontWeight: 800 },
    }, "＋休憩を追加"),
    props.hasIncompleteBreak
      ? createElement("p", { style: { margin: "10px 0 0", borderRadius: 8, background: "#FEF2F2", color: "#991B1B", padding: 10, fontWeight: 700 } }, "休憩打刻が未完了です。空欄を補完するか、不要な休憩を削除してください。")
      : null,
    createElement("div", { style: { marginTop: 12, padding: 10, background: "#ffffff", borderRadius: 8, fontSize: 13 } },
      createElement("div", null, `休憩合計：${props.formatMinutes(props.breakMinutes)}`),
      createElement("div", null, `修正後労働時間：${props.workMinutes == null ? "未確定" : props.formatMinutes(props.workMinutes)}`),
      createElement("div", null, `修正後深夜時間：${props.nightMinutes == null ? "未確定" : props.formatMinutes(props.nightMinutes)}`),
    ),
  );
}
