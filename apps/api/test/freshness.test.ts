import { describe, it, expect } from "vitest";
import {
  extractYear,
  freshnessPenalty,
  freshnessFactor,
  isSuperseded,
  FRESHNESS_PENALTY_CAP,
  FRESHNESS_PENALTY_FULL_YEARS,
} from "../src/lib/freshness";

// 基準日を 2026-06-23 に固定（経過年数の安定化）。
const NOW = new Date(2026, 5, 23);

describe("extractYear: 事務連絡タイトルから和暪発出年（西暦）を抽出", () => {
  it("平成表記あり → 平成Y = 1988+Y", () => {
    expect(extractYear("27.4.1事務連絡介護保険最新情報vol.454「平成27年度介護報酬改定に関するQ&A」の送付について")).toBe(2015);
    expect(extractYear("24.3.16事務連絡介護保険最新情報vol.267「平成２４年度介護報酬改定に関するＱ＆A")).toBe(2012);
    expect(extractYear("30.3.23事務連絡「平成30年度介護報酬改定に関するQ&A」")).toBe(2018);
    expect(extractYear("31.4.12事務連絡「平成31年4月12日」")).toBe(2019);
  });

  it("令和表記あり → 令和Y = 2018+Y", () => {
    expect(extractYear("3.3.26事務連絡介護保険最新情報vol.952「令和3年度介護報酬改定に関するQ&A」")).toBe(2021);
    expect(extractYear("2.3.30事務連絡「2019年度介護報酬改定に関するＱ＆A（令和2年3月30日）」")).toBe(2020);
    expect(extractYear("4.2.21事務連絡介護保険最新情報vol.1035「令和4年2月")).toBe(2022);
  });

  it("元号表記なし yr≥12 → 平成（制度開始平成12年=2000 以降）", () => {
    expect(extractYear("14.3.28事務連絡運営基準等に係るQ&A")).toBe(2002);
    expect(extractYear("12.3.31事務連絡介護保険最新情報vol.59その他の日常生活費に係るQ&Aについて")).toBe(2000);
    expect(extractYear("15.5.30事務連絡介護保険最新情報vol.151介護報酬に係るQ&A")).toBe(2003);
    expect(extractYear("18.3.22介護制度改革informationvol.78平成18年4月改定関係Q＆A")).toBe(2006);
  });

  it("元号表記なし yr≤7 → 令和（平成3年=1991は制度前で存在しえない）", () => {
    // corpus 実データ: yr=3 は令和3年度改定のQ&A
    expect(extractYear("3.3.19事務連絡介護保険最新情報vol.941「令和3年度")).toBe(2021);
  });

  it("先頭「元」→ 令和元年(2019)", () => {
    expect(extractYear("元.7.23事務連絡「2019年度介護報酬改定に関するＱ＆A")).toBe(2019);
    expect(extractYear("元.8.29事務連絡「2019年度介護報酬改定に関するＱ＆A")).toBe(2019);
  });

  it("全角数字・全角ドット → 半角化して抽出", () => {
    expect(extractYear("５.２.15事務連絡介護保険最新情報vol.1127「令和３")).toBe(2023);
  });

  it("空白帯 yr=8-11 → null（平成8-11年=制度前 / 令和8-11年=未来、両方あり得る安全側）", () => {
    expect(extractYear("8.4.1事務連絡何らかのQ&A")).toBeNull();
    expect(extractYear("10.3.1事務連絡何らかのQ&A")).toBeNull();
    expect(extractYear("11.12.1事務連絡何らかのQ&A")).toBeNull();
  });

  it("抽出不能 → null", () => {
    expect(extractYear(null)).toBeNull();
    expect(extractYear(undefined)).toBeNull();
    expect(extractYear("")).toBeNull();
    expect(extractYear("事務連絡介護保険最新情報vol.20指定地域密着型サービス")).toBeNull();
  });
});

describe("freshnessPenalty: 経過年数の線形マイルド減点", () => {
  it("今年以降の発出 → 0（減点なし）", () => {
    expect(freshnessPenalty(2026, NOW)).toBe(0);
    expect(freshnessPenalty(2027, NOW)).toBe(0);
  });

  it("線形: 10年=0.15 / 5年=0.075", () => {
    expect(freshnessPenalty(2016, NOW)).toBeCloseTo(0.15, 5);
    expect(freshnessPenalty(2021, NOW)).toBeCloseTo(0.075, 5);
  });

  it("FULL_YEARS(20年) で cap に到達", () => {
    expect(freshnessPenalty(2006, NOW)).toBeCloseTo(FRESHNESS_PENALTY_CAP, 5);
  });

  it("cap 超は頭打ち（30年古くても cap=0.3）", () => {
    expect(freshnessPenalty(1996, NOW)).toBe(FRESHNESS_PENALTY_CAP);
    expect(freshnessPenalty(2000, NOW)).toBe(FRESHNESS_PENALTY_CAP);
  });

  it("発出年 null → 0（鮮度不明は減点しない・gold-A系保護）", () => {
    expect(freshnessPenalty(null, NOW)).toBe(0);
  });
});

describe("freshnessFactor: 鮮度係数(1-penalty) で cosine に掛ける", () => {
  it("新しい=1.0 / 令和3年(2021,5年)=0.925 / 平成27年(2015,11年)=0.835 / null=1.0", () => {
    expect(freshnessFactor("3.3.26事務連絡…令和3年度", NOW)).toBeCloseTo(0.925, 3);
    expect(freshnessFactor("27.4.1事務連絡…平成27年度", NOW)).toBeCloseTo(0.835, 3);
    expect(freshnessFactor(null, NOW)).toBe(1.0);
  });
});

describe("isSuperseded: 明示マーカーによる置き換え判定", () => {
  it("heading に「削除」→ true", () => {
    expect(isSuperseded("〇〇に関するQ&A削除", "12.4.28事務連絡")).toBe(true);
  });

  it("date に「廃止」→ true", () => {
    expect(isSuperseded("某加算について", "30.3.23事務連絡…廃止された加算")).toBe(true);
  });

  it("date に「追補版の修正」→ true", () => {
    expect(isSuperseded("某見出し", "17.11.4事務連絡…追補版】の修正について")).toBe(true);
  });

  it("マーカーなし → false（機械的同一heading新旧は判定しない）", () => {
    expect(isSuperseded("常勤換算方法により算定される従業者の休暇等の取扱い", "14.3.28事務連絡運営基準等に係るQ&A")).toBe(false);
  });

  it("両方 null → false", () => {
    expect(isSuperseded(null, null)).toBe(false);
  });
});
