// ライブの段1ルータ（ADR 0001 Step2b = ai.ts wiring）。
//
// 事前計算済みの成果物（models/routing/current.json）をロードし、実行時は受信プロンプト
// 1件だけを埋め込んで edge/cloud を判定する。起動時のプロトタイプ再埋め込み（旧実装）は廃止:
//   - コールドスタート誤振り分けが消える（起動直後から確定済み境界）。
//   - dev/prod 決定性（成果物は build:model で git に固定。再現は npm run build:model）。
// 成果物の作り直しは scripts/build-routing-model.ts（npm run build:model -w @hybrid/api）。
//
// 閾値は成果物に同梱（build 時に train で非対称コスト最小化）。env で上書き可（実験用）。
// ※ 埋め込みモデルは成果物の embedModel に合わせる（取り違えは classify 時に次元不一致で throw）。

import { OllamaEmbedProvider, type EmbedProvider } from "@/lib/embed";
import {
  parseRoutingModel,
  classifierFromModel,
  type RoutingClassifier,
} from "@/lib/routing-model";
import currentArtifact from "../../models/routing/current.json";

export type { RoutingClassifier };

// 起動時に1度だけ検証・展開（埋め込み計算は伴わない＝コールドスタートなし）。
const model = parseRoutingModel(currentArtifact);

const thresholdOverride = process.env.AI_ROUTER_THRESHOLD;
if (thresholdOverride !== undefined && thresholdOverride.trim() !== "") {
  model.threshold = Number(thresholdOverride);
}

/** Router Observability 用の成果物メタ（versions 記録に使う）。 */
export const routerInfo = {
  classifierVersion: model.version,
  embedModel: model.embedModel,
};

/**
 * 成果物から段1ルータを得る。
 * embed 未指定時は成果物の embedModel で Ollama を構築（serving と成果物の埋め込み空間を一致させる）。
 * prod（Workers AI 埋め込み）は将来この引数で注入する（Provider 抽象の seam を維持）。
 */
export function getRoutingClassifier(embed?: EmbedProvider): RoutingClassifier {
  return classifierFromModel(
    model,
    embed ?? new OllamaEmbedProvider(undefined, model.embedModel),
  );
}
