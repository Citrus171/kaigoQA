// date鮮度スコアリング（②date鮮度ロジック）。
//
// rag_chunks.date は事務連絡タイトル長文（例: "27.4.1事務連絡介護保険最新情報vol.454
// 「平成27年度介護報酬改定に関するQ&A」の送付について"）。先頭の和暪日付から西暦年を抽出し、
// 経過年数に応じて鮮度ペナルティを与える（減点 rerank）。同 cosine 帯で新しい方を上位に。
//
// 和暪→西暦変換の方針（実測 corpus: 平成12-31/令和2-4 の2帯のみ）:
//   1. 全角数字・全角ドットを半角化
//   2. 先頭「元」= 令和元年(2019)
//   3. 先頭「Y.M.D」パターン抽出
//   4. date 内の元号表記（平成/令和）で判別 → なければ yr≤7=令和 / yr≥8=平成
//      （空白帯 yr=8-11: 平成8-11年=1996-1999は制度前、令和8-11年=2026-2029は未来。
//       corpus に出現しない想定。出たら安全側 null）
//   5. 西暦: 平成Y = 1988+Y / 令和Y = 2018+Y
//
// superseded（後発Q&Aで置き換え）は明示マーカーのみ（heading/date に「削除」「廃止」
// 「追補版の修正」含むチャンクを候補から落とす）。機械的「同一heading新旧」は誤爆リスクで不使用。

/** 全角数字・全角ドットを半角化。和暪日付抽出の前処理。 */
function normalize(s: string): string {
  // 全角数字 ０-９(U+FF10-FF19) → 半角 0-9(U+0030-0039)。差 0xFEE0。
  // 全角ドット ．(U+FF0E) / 。(U+3002) → 半角 .(U+002E)
  return s
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[．。]/g, ".");
}

/**
 * 事務連絡タイトル文字列から発出年（西暦）を抽出する。
 * @returns 西暦年（例: 2021）。抽出不能は null（鮮度判定から除外・ペナルティなし）。
 */
export function extractYear(date: string | null | undefined): number | null {
  if (!date) return null;
  const s = normalize(date);
  // 先頭「元.M.D」= 令和元年(2019)
  if (/^元[.]/.test(s)) return 2019;
  // 先頭「Y.M.D」パターン（半角数字・半角ドット）
  const m = s.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const yr = Number(m[1]);
  if (!Number.isFinite(yr) || yr < 1) return null;
  // 元号表記で優先判別
  const hasHeisei = s.includes("平成");
  const hasReiwa = s.includes("令和");
  if (hasHeisei && !hasReiwa) return 1988 + yr;
  if (hasReiwa && !hasHeisei) return 2018 + yr;
  // 元号表記なし → 空白帯ヒューリスティック
  //   yr 1-7 = 令和（corpus 実範囲: 令和2-4）、yr 8-11 = 空白帯（null）、yr≥12 = 平成
  if (yr <= 7) return 2018 + yr;
  if (yr >= 12) return 1988 + yr;
  // yr 8-11: 制度前の平成8-11年 と 未来の令和8-11年 が両方あり得る → 安全側 null
  return null;
}

/** 鮮度ペナルティの上限（cap）。20年で 0.3 減点に漸近。古くても 30% まで。 */
export const FRESHNESS_PENALTY_CAP = 0.3;
/** ペナルティが満タンに達する経過年数。これを超えると cap で頭打ち。 */
export const FRESHNESS_PENALTY_FULL_YEARS = 20;

/**
 * 発出年から鮮度ペナルティ（0〜cap）を算出。線形マイルド。
 * penalty = (yearsOld / FULL_YEARS) * CAP を cap で頭打ち → 10年=0.15 / 20年=0.30 / 30年=0.30
 * @param issuedYear 発出年（西暦）。null は 0（鮮度不明は減点しない・gold-A系保護）。
 * @param now 基準日（既定=本日）。テストで固定可能。
 */
export function freshnessPenalty(issuedYear: number | null, now: Date = new Date()): number {
  if (issuedYear == null) return 0;
  const nowYear = now.getFullYear();
  const yearsOld = nowYear - issuedYear;
  if (yearsOld <= 0) return 0; // 今年以降の発出は減点なし（未来データはないが安全側）
  const linear = (yearsOld / FRESHNESS_PENALTY_FULL_YEARS) * FRESHNESS_PENALTY_CAP;
  return Math.min(linear, FRESHNESS_PENALTY_CAP);
}

/** superseded 明示マーカー。heading/date にこれらが含まれるチャンクは候補から除外。 */
const SUPERSEDED_MARKERS = ["削除", "廃止", "追補版の修正", "追補版】の修正"];

/**
 * 明示マーカーによる superseded 判定。heading と date の両方を走査。
 * 機械的「同一heading新旧」は誤爆リスクのため不使用（ユーザー合意: 明示マーカーのみ）。
 */
export function isSuperseded(heading: string | null | undefined, date: string | null | undefined): boolean {
  const text = `${heading ?? ""} ${date ?? ""}`;
  return SUPERSEDED_MARKERS.some((m) => text.includes(m));
}

/**
 * date 鮮度係数（1 - penalty）。rerank で cosine score に掛ける。
 * 新しい=1.0、20年古い=0.7、鮮度不明=1.0（減点しない）。
 */
export function freshnessFactor(date: string | null | undefined, now: Date = new Date()): number {
  return 1 - freshnessPenalty(extractYear(date), now);
}
