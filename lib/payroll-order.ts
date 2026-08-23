import type { PayrollResult } from "./payroll.ts";

// 2026年8月給与振込一覧.xlsx と従業員マスターを照合した固定順。
// employeeIdを最優先し、社員コードと氏名が両方一致した場合だけ代替照合する。
const REFERENCE_ORDER = [
  ["rQQf2dwbkFbUNn13gG0M", "1076", "松本るぴな"], ["", "", "髙木サンドラ"], ["h1Ikn9BABiXSknfiBWju", "8172", "寺石彩乃"],
  ["hvjU14BKDB0pCdDrUZF1", "0003", "中村鏡太郎"], ["", "0017", "木月徳子"],
  ["c6ADSFHwyHecwScuZ6g8", "0064", "小林彗太"], ["zbpOikyklko5CL6G6Yon", "0083", "佐藤雅信"],
  ["57siuRPs3nEZ1Ntm7ahJ", "1068", "岸桜来"], ["AgqriwE0RpyrQiCLp97S", "3029", "佐久間美涼"],
  ["WN7dC2xNeRQl7xChcAZc", "1065", "井上美咲"], ["", "", "デネシクマル"], ["aHBZpujtiu93YEU2Es1a", "4086", "小林美穂"], ["", "", "近藤南"],
  ["g4la53I4y0wNbMj5iLz9", "1077", "田村香織"], ["lgudjtEcC9nLikILgmiY", "1080", "寺嶌桃子"],
  ["0T493reIkr5Oi9ch29ms", "7015", "川島胡桃"], ["ONRefCpUMyX3eZ75ukA6", "1070", "木下航平"],
  ["ov7awXLa6YaC5iI2qZiT", "7014", "有泉春花"], ["g2w2qL82szcgbGoXQd5K", "7016", "松村絢菜"], ["", "", "志賀昴"], ["", "", "君島杏樹"],
  ["V6Kg3SNfHCA5aUwLy1Lu", "4098", "漆原健太"], ["SpZ9m4UDdQqjpDnJInPY", "8165", "安齋莉奈"],
  ["VyQG7qnkxuMGfBC1sR0u", "8170", "工藤紗玖良"], ["vwuoA0qj0Us1iFEmTO9r", "4101", "溝上太康"],
  ["gCDrwiiJECJopX5QEhyQ", "4111", "曽崎大輔"], ["", "", "齊藤稜久"], ["", "", "城菜月"], ["rM4NyRBrQvXXzIMgjq4f", "1069", "篠原美楽"], ["", "", "田部里桜菜"],
  ["wW2ms6AsOWbwjxhCEQFl", "4112", "森愛礼奈"], ["oxPBdiFtQQz7joU0cEea", "4114", "加藤愛菜"],
  ["EwOQ7tvxMQ8IJFbrLI7V", "7017", "三浦美帆"], ["", "0002", "青山佳史"],
] as const;

const compact = (value: string) => value.replace(/[\s　]/g, "");

export function payrollOrderOf(result: Pick<PayrollResult, "employeeId" | "employeeCode" | "employeeName">) {
  const byId = REFERENCE_ORDER.findIndex(([id]) => id && id === result.employeeId);
  if (byId >= 0) return byId;
  const code = String(result.employeeCode).padStart(4, "0");
  const byIdentity = REFERENCE_ORDER.findIndex(([, expectedCode, name]) => expectedCode === code && name === compact(result.employeeName));
  return byIdentity >= 0 ? byIdentity : Number.MAX_SAFE_INTEGER;
}

export function sortPayrollResults<T extends PayrollResult>(results: T[]): T[] {
  const nameCounts = new Map<string, number>();
  for (const result of results) nameCounts.set(compact(result.employeeName), (nameCounts.get(compact(result.employeeName)) ?? 0) + 1);
  const order = (result: T) => {
    const strict = payrollOrderOf(result);
    if (strict !== Number.MAX_SAFE_INTEGER) return strict;
    const name = compact(result.employeeName);
    if (nameCounts.get(name) === 1) {
      const byUniqueName = REFERENCE_ORDER.findIndex(([, , expectedName]) => expectedName === name);
      if (byUniqueName >= 0) return byUniqueName;
    }
    return Number.MAX_SAFE_INTEGER;
  };
  return [...results].sort((a, b) => order(a) - order(b) || (a.payrollTransferOrder ?? Number.MAX_SAFE_INTEGER) - (b.payrollTransferOrder ?? Number.MAX_SAFE_INTEGER) || a.employeeCode.localeCompare(b.employeeCode, "ja", { numeric: true }) || a.employeeId.localeCompare(b.employeeId));
}
