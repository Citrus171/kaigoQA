-- Router Observability 集計SQL雛形（routing_decisions テーブル）
--
-- 対象: src/db/schema.ts の routing_decisions
--   列: ts, query_ref(sha256先端), method('classifier'|'rule'), score, threshold, margin(=score-threshold),
--       sim_cloud, sim_edge, edge_confidence, escalated, guardrail_esc, served('edge'|'cloud'),
--       embed_model, classifier_version, gen_model, latency_embed/gen/total
-- 意味: score=sim_cloud-sim_edge。score>threshold で cloud。margin の符号=判定方向、絶対値=確信度の近似。
--   rule 経路（埋め込み不通フォールバック）は score/threshold/margin/sim が NULL。
-- PII: query_ref はハッシュ先端のみ。原文は gated ストア側で hash→text を引く（本SQLでは扱わない）。
-- ε(境界幅) は各クエリ冒頭の params CTE で調整する。運用ラベルで較正するまでは暫定値。
--
-- 実行: psql "$DATABASE_URL" -f apps/api/eval/router-observability-queries.sql
--   （個別に流す場合は該当ブロックをコピー）

-- =====================================================================
-- 1. offload率（実測）— コスト削減効果。全体＋日次推移。
-- =====================================================================
-- 全体
SELECT
  count(*)                                            AS total,
  count(*) FILTER (WHERE served = 'edge')             AS edge_served,
  round(100.0 * count(*) FILTER (WHERE served = 'edge') / nullif(count(*),0), 1) AS offload_pct
FROM routing_decisions;

-- 日次推移（設計値17-20%からの乖離＝閾値/分布ドリフトの兆候）
SELECT
  date_trunc('day', ts)                               AS day,
  count(*)                                            AS total,
  round(100.0 * count(*) FILTER (WHERE served = 'edge') / nullif(count(*),0), 1) AS offload_pct
FROM routing_decisions
GROUP BY 1 ORDER BY 1;

-- =====================================================================
-- 2. 境界ケース抽出（flywheel候補）— |margin|<ε。review-queue へ送る種。
--    classifier 経路のみ（rule は margin NULL）。両側の不確実判定を拾う。
-- =====================================================================
WITH params AS (SELECT 0.01::real AS eps)
SELECT
  d.ts, d.query_ref, d.served, d.score, d.threshold, d.margin,
  d.sim_cloud, d.sim_edge, d.edge_confidence, d.escalated, d.guardrail_esc
FROM routing_decisions d, params p
WHERE d.method = 'classifier'
  AND abs(d.margin) < p.eps
ORDER BY abs(d.margin) ASC          -- 最も曖昧な順＝ラベリング優先
LIMIT 200;

-- =====================================================================
-- 3. FNリスク — served=edge かつ閾値ぎりぎり下（-ε≤margin≤0）。
--    cloud相当をedgeで返した疑い（最も危険なコスト）。要・重点レビュー。
-- =====================================================================
WITH params AS (SELECT 0.01::real AS eps)
SELECT
  count(*)                                                    AS edge_total,
  count(*) FILTER (WHERE d.margin >= -p.eps)                  AS fn_risk_n,
  round(100.0 * count(*) FILTER (WHERE d.margin >= -p.eps) / nullif(count(*),0), 1) AS fn_risk_pct
FROM routing_decisions d, params p
WHERE d.served = 'edge' AND d.method = 'classifier';

-- FNリスク該当の明細（レビュー対象）
WITH params AS (SELECT 0.01::real AS eps)
SELECT d.ts, d.query_ref, d.score, d.threshold, d.margin, d.edge_confidence
FROM routing_decisions d, params p
WHERE d.served = 'edge' AND d.method = 'classifier'
  AND d.margin >= -p.eps
ORDER BY d.margin DESC               -- 0 に近い＝最も cloud 寄りだった順
LIMIT 200;

-- =====================================================================
-- 4. stage2 escalation率 — 段1edge → 自信不足/ガードレールで cloud 巻き戻し。
--    分母=段1がedgeと判定した件（stage2が存在＝escalated IS NOT NULL）。
-- =====================================================================
SELECT
  count(*)                                                AS stage1_edge,
  count(*) FILTER (WHERE escalated)                       AS conf_escalated,   -- 自信不足
  count(*) FILTER (WHERE guardrail_esc)                   AS guardrail_escalated, -- 危険断定
  round(100.0 * count(*) FILTER (WHERE escalated OR guardrail_esc) / nullif(count(*),0), 1) AS escalation_pct
FROM routing_decisions
WHERE escalated IS NOT NULL;          -- = 段1edge（段1cloudは stage2 なし＝NULL）

-- =====================================================================
-- 5. tier別 latency 分布（served 基準）— ユーザー体験の実測。
-- =====================================================================
SELECT
  served,
  count(*)                                                       AS n,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_total)    AS p50_total_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_total)    AS p95_total_ms,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_gen)      AS p50_gen_ms,
  percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_embed)    AS p50_embed_ms
FROM routing_decisions
GROUP BY served;

-- =====================================================================
-- 6. score 分布ドリフト — 日次の代表値。train分布からの乖離監視。
--    classifier 経路のみ。avg/stddev と分位点が時間で動けば再ビルド/閾値再評価の兆候。
-- =====================================================================
SELECT
  date_trunc('day', ts)                                   AS day,
  count(*)                                                AS n,
  round(avg(score)::numeric, 4)                           AS avg_score,
  round(stddev_pop(score)::numeric, 4)                    AS sd_score,
  round(percentile_cont(0.10) WITHIN GROUP (ORDER BY score)::numeric, 4) AS p10,
  round(percentile_cont(0.50) WITHIN GROUP (ORDER BY score)::numeric, 4) AS p50,
  round(percentile_cont(0.90) WITHIN GROUP (ORDER BY score)::numeric, 4) AS p90
FROM routing_decisions
WHERE method = 'classifier'
GROUP BY 1 ORDER BY 1;

-- score ヒストグラム（境界=threshold 付近の密度を見る）。直近7日。
WITH params AS (SELECT 20 AS buckets, -0.2::real AS lo, 0.2::real AS hi)
SELECT
  width_bucket(score, p.lo, p.hi, p.buckets)              AS bucket,
  round(min(score)::numeric, 3)                           AS bucket_min,
  count(*)                                                AS n,
  count(*) FILTER (WHERE served='edge')                   AS edge_n
FROM routing_decisions d, params p
WHERE d.method = 'classifier' AND d.ts > now() - interval '7 days'
GROUP BY 1 ORDER BY 1;

-- =====================================================================
-- 7. 健全性 — rule フォールバック率（埋め込み不通の頻度）。高ければ Ollama/Workers AI 不調。
-- =====================================================================
SELECT
  count(*)                                                AS total,
  count(*) FILTER (WHERE method = 'rule')                 AS rule_fallback,
  round(100.0 * count(*) FILTER (WHERE method = 'rule') / nullif(count(*),0), 2) AS rule_pct,
  count(DISTINCT classifier_version)                      AS classifier_versions,
  count(DISTINCT embed_model)                             AS embed_models
FROM routing_decisions;
