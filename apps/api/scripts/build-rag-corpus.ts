// RAG コーパス成果物のビルドスクリプト（フェーズ2 Capability Router の retrieval 基盤）。
//
// eval の gold（referencePoints）と事前計算済み埋め込みキャッシュ（CF bge-m3, 1024次元）を
// 突き合わせ、API 実行時に eval/ へ依存しない自己完結な成果物 JSON を出力する。
// これにより serving（src/lib/rag.ts）は models/rag/corpus.json だけをロードすれば動く。
//
// 実行: npm run build:rag -w @hybrid/api
//
// 入力:
//   eval/data/routing-gold-a.jsonl                  … gid + referencePoints（chunk本文）
//   eval/data/rag-corpus-embeddings-qlevel-v2.json  … 135件の埋め込み（gold順に整列）
// 出力:
//   models/rag/corpus.json … {embedModel, dim, chunks:[{srcId,text,vector}]}
//
// 整列規約: Python out42 の build_qlevel_corpus と同一。
//   referencePoints を持つ gold を jsonl 出現順に並べ、その順序が埋め込み配列と 1:1 対応する。
//   （現状 135件すべてが referencePoints を持つ＝全件対象。）

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "..", "eval", "data");
const GOLD_PATH = join(DATA, "routing-gold-a.jsonl");
const EMBED_CACHE = join(DATA, "rag-corpus-embeddings-qlevel-v2.json");
const OUT_DIR = join(HERE, "..", "models", "rag");
const OUT_PATH = join(OUT_DIR, "corpus.json");

// Python パイプラインと一致させる埋め込みモデル（キャッシュの生成元）。
const EMBED_MODEL = "@cf/baai/bge-m3";

type GoldRow = { id: string; referencePoints?: string[] };

function loadGold(): GoldRow[] {
  return readFileSync(GOLD_PATH, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as GoldRow);
}

function loadEmbeds(): number[][] {
  const cache = JSON.parse(readFileSync(EMBED_CACHE, "utf8")) as {
    embeddings: number[][];
  };
  return cache.embeddings;
}

function main() {
  const gold = loadGold();
  const embeds = loadEmbeds();

  // referencePoints を持つ gold（= corpus 対象）を出現順に。
  const corpusGold = gold.filter(
    (g) => (g.referencePoints?.length ?? 0) > 0,
  );

  if (corpusGold.length !== embeds.length) {
    throw new Error(
      `整列不一致: corpus gold ${corpusGold.length}件 vs 埋め込み ${embeds.length}件。` +
        `埋め込みキャッシュの再生成が必要です。`,
    );
  }

  const dim = embeds[0]?.length ?? 0;
  if (dim === 0) throw new Error("埋め込み次元が 0 です");

  const chunks = corpusGold.map((g, i) => {
    const vec = embeds[i]!;
    if (vec.length !== dim) {
      throw new Error(`次元不一致 at ${g.id}: ${vec.length} vs ${dim}`);
    }
    return {
      srcId: g.id,
      text: (g.referencePoints ?? []).join("\n"),
      vector: vec,
    };
  });

  // 取り違え・サイレント変更の検知用ハッシュ（text のみ。ベクトルは text に従属）。
  const sourceHash =
    "sha256:" +
    createHash("sha256")
      .update(JSON.stringify(chunks.map((c) => [c.srcId, c.text])))
      .digest("hex");

  const artifact = {
    embedModel: EMBED_MODEL,
    dim,
    builtAt: new Date().toISOString(),
    sourceHash,
    count: chunks.length,
    chunks,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(artifact));
  console.log(
    `RAG コーパス成果物を出力: ${OUT_PATH}\n` +
      `  chunks=${chunks.length} dim=${dim} embedModel=${EMBED_MODEL}\n` +
      `  ${sourceHash}`,
  );
}

main();
