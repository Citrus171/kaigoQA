#!/usr/bin/env python3
"""out/25 を受けた post-hoc cascade 検証（追加生成ゼロ）。

仮説: pre-gen 特徴は無力だったが、edge "回答" を見れば edge_good を判定できる。
特に non-good 26件は全て partial(十分性不足) → 「回答が参照をどれだけカバーしたか」が効くはず。

特徴（全て post-hoc = edge生成後に取得可能）:
  - ans_len   : edge回答 文字数（out/25 で r=0.42）
  - coverage  : mean_i cos(edge回答, ref_i)  ※全 referencePoints をまんべんなくカバーしたか
  - min_sim   : min_i cos(edge回答, ref_i)   ※最弱カバー点（欠落 = partial の直接代理）
埋め込み = bge-m3（ローカル Ollama, 既存ルーティングと同一）。

判定: verifier が「edge採用」と判断→edge結果、それ以外→cloud escalate。
  selective_good = Σ(edge_good if 採用 else cloud_good)
  Oracle Capture = (selective% − 63.4) / (70.7 − 63.4)   ※>0 で cloud超え、≥50%で実用価値(out/25)

env: OLLAMA_URL（既定 localhost:11434）
"""
import json, os, requests, statistics as st

ROOT = os.path.join(os.path.dirname(__file__), "..", "..", "..")
def P(*a): return os.path.join(ROOT, *a)
OLLAMA = os.environ.get("OLLAMA_URL", "http://localhost:11434")

edge = {it["id"]: it for it in json.load(open(P("apps/api/eval/data/phaseA-gemma4-incontext-results-edge-thinkoff.json")))["items"]}
cloud = {json.loads(l)["id"]: bool(json.loads(l)["good"]) for l in open(P("apps/api/eval/data/measA-cloud-rag-edge.jsonl"))}
gold = {json.loads(l)["id"]: json.loads(l) for l in open(P("apps/api/eval/data/routing-gold-a.jsonl")) if l.strip()}
ids = sorted(set(edge) & set(cloud))
N = len(ids)
CLOUD_RATE = sum(cloud[i] for i in ids) / N * 100   # 63.4
ORACLE_RATE = sum(1 for i in ids if edge[i]["new_good"] or cloud[i]) / N * 100  # 70.7

def embed(texts):
    r = requests.post(f"{OLLAMA}/api/embed", json={"model": "bge-m3", "input": texts}, timeout=300)
    r.raise_for_status()
    return r.json()["embeddings"]

def cos(a, b):
    import math
    d = sum(x*y for x, y in zip(a, b)); na = math.sqrt(sum(x*x for x in a)); nb = math.sqrt(sum(y*y for y in b))
    return d/(na*nb) if na and nb else 0.0

# 特徴量抽出（answer と 各 ref を embed）
rows = []
for i in ids:
    ans = edge[i]["answer"]
    refs = gold[i].get("referencePoints") or ([gold[i]["answer"]] if gold[i].get("answer") else [])
    vecs = embed([ans] + refs)
    av, rvs = vecs[0], vecs[1:]
    sims = [cos(av, rv) for rv in rvs] or [0.0]
    rows.append({"id": i, "egood": bool(edge[i]["new_good"]), "cgood": cloud[i],
                 "ans_len": len(ans), "coverage": sum(sims)/len(sims), "min_sim": min(sims)})

def pearson(xs, ys):
    n = len(xs); mx = sum(xs)/n; my = sum(ys)/n
    cov = sum((x-mx)*(y-my) for x, y in zip(xs, ys))
    sx = (sum((x-mx)**2 for x in xs))**.5; sy = (sum((y-my)**2 for y in ys))**.5
    return cov/(sx*sy) if sx and sy else 0.0

ys = [1.0 if r["egood"] else 0.0 for r in rows]
print(f"対象 {N}件 / cloud+RAG={CLOUD_RATE:.1f}% / oracle={ORACLE_RATE:.1f}%")
print("\n=== 特徴量 × edge_good 相関(post-hoc) ===")
for f in ("ans_len", "coverage", "min_sim"):
    print(f"  {f}: r={pearson([r[f] for r in rows], ys):+.3f}")

def evaluate(score_key, hi_is_edge=True):
    """score>=thr を edge採用とみなし、capture最大の閾値を全探索。"""
    vals = sorted(set(r[score_key] for r in rows))
    best = None
    for thr in vals:
        adopt = [(r[score_key] >= thr) if hi_is_edge else (r[score_key] <= thr) for r in rows]
        if not any(adopt):  # 全escalate = all-cloud と同値、capture 0。スキップ
            continue
        sg = sum((rows[k]["egood"] if adopt[k] else rows[k]["cgood"]) for k in range(N))
        rate = sg/N*100
        n_adopt = sum(adopt); tp = sum(1 for k in range(N) if adopt[k] and rows[k]["egood"])
        prec = tp/n_adopt*100 if n_adopt else 0
        cap = (rate-CLOUD_RATE)/(ORACLE_RATE-CLOUD_RATE)*100
        cand = {"thr": thr, "rate": rate, "cap": cap, "prec": prec, "offload": n_adopt/N*100}
        if best is None or cand["cap"] > best["cap"]:
            best = cand
    return best

print("\n=== post-hoc 単一特徴 verifier（閾値全探索・best capture）===")
print(f"{'特徴':12} {'方向':6} {'thr':>7} {'selective%':>10} {'capture%':>9} {'prec%':>7} {'offload%':>8}")
for f, hi in [("ans_len", True), ("coverage", True), ("min_sim", True)]:
    b = evaluate(f, hi)
    if b:
        print(f"{f:12} {'高=edge':6} {b['thr']:7.3f} {b['rate']:10.1f} {b['cap']:9.1f} {b['prec']:7.1f} {b['offload']:8.1f}")

# 2特徴 logistic（標準化 + 簡易勾配降下）でも capture を確認
def logistic_capture():
    import math
    feats = ["ans_len", "coverage", "min_sim"]
    X = [[r[f] for f in feats] for r in rows]
    mu = [sum(c)/N for c in zip(*X)]; sd = [(sum((x-mu[j])**2 for x in c)/N)**.5 or 1 for j, c in enumerate(zip(*X))]
    Xn = [[(row[j]-mu[j])/sd[j] for j in range(len(feats))] for row in X]
    w = [0.0]*len(feats); b = 0.0; lr = 0.3
    for _ in range(2000):
        for k in range(N):
            z = b + sum(w[j]*Xn[k][j] for j in range(len(feats))); p = 1/(1+math.exp(-z)); g = p-ys[k]
            b -= lr*g/N
            for j in range(len(feats)): w[j] -= lr*g*Xn[k][j]/N
    probs = [1/(1+math.exp(-(b+sum(w[j]*Xn[k][j] for j in range(len(feats)))))) for k in range(N)]
    best = None
    for thr in sorted(set(probs)):
        adopt = [p >= thr for p in probs]
        if not any(adopt): continue
        sg = sum((rows[k]["egood"] if adopt[k] else rows[k]["cgood"]) for k in range(N)); rate = sg/N*100
        cap = (rate-CLOUD_RATE)/(ORACLE_RATE-CLOUD_RATE)*100
        n_adopt = sum(adopt); tp = sum(1 for k in range(N) if adopt[k] and rows[k]["egood"]); prec = tp/n_adopt*100
        c = {"rate": rate, "cap": cap, "prec": prec, "offload": n_adopt/N*100}
        if best is None or c["cap"] > best["cap"]: best = c
    return best, dict(zip(feats, w))

lb, w = logistic_capture()
print(f"\n=== 3特徴 logistic（in-sample・楽観上限）===")
print(f"  weights(標準化): " + ", ".join(f"{k}={v:+.2f}" for k, v in w.items()))
print(f"  best: selective={lb['rate']:.1f}% capture={lb['cap']:.1f}% prec={lb['prec']:.1f}% offload={lb['offload']:.1f}%")
print(f"\n判定基準: capture>0 で cloud超え / ≥50% で実用価値(out/25)。※単一特徴は in-sample 楽観値の点に留意。")
