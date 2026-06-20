#!/usr/bin/env python3
"""out/26 判定軸の再測定: oracle/real の4系統答案を「同一judge・同一参照(全referencePoints)」で再採点。

背景: 元の out/26 は oracle=全ref採点(phaseA過去run) / real=retrieval-ref採点(今回run) と
judge入力参照が非対称（temp=0なので揺らぎでなく系統差）。比較不能だった。
ここでは answer をそのまま流用し、judge に渡す参照を全 referencePoints(gold) に統一して
全件採点し直す。these results で 2×2 を組み直す。

usage (eval ディレクトリから):  python3 rejudge-out26.py
"""
import os, json, re, math
import requests
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))           # apps/api/eval
DATA = os.path.join(HERE, "data")

# ── env (apps/api/.env) ──
env_path = os.path.join(HERE, "..", ".env")
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

ORK         = os.environ["OPENROUTER_API_KEY"]
JUDGE_MODEL = os.environ.get("JUDGE_MODEL", "openai/gpt-4o")
JUDGE_URL   = "https://openrouter.ai/api/v1/chat/completions"

GOLD_PATH   = os.path.join(DATA, "routing-gold-a.jsonl")
EDGE_ORACLE = os.path.join(DATA, "phaseA-gemma4-incontext-results-edge-thinkoff.json")
CLOUD_ORACLE= os.path.join(DATA, "measA-cloud-rag-edge.jsonl")
EDGE_REAL   = os.path.join(DATA, "rag-mvp-edge.jsonl")
CLOUD_REAL  = os.path.join(DATA, "rag-mvp-cloud.jsonl")
OUT_CACHE   = os.path.join(DATA, "rejudge-out26-verdicts.json")


def isgood(v):
    return bool(v) and v.get("factual") and v.get("sufficient") and not v.get("overreach")


def judge(query, answer, refs):
    """GPT-4o judge（rag-mvp.py の judge() と同一プロンプト・同一基準）。"""
    ref_text = "\n".join(f"- {pt}" for pt in refs)
    prompt = f"""あなたは日本の介護保険制度に精通した審査員です。AIの回答を厳格に採点してください。

質問: {query}
正解の要点（この事実に照らして採点）:
{ref_text}

AIの回答: {answer}

次のキーを持つJSONのみを返答（前置き・コードフェンス不要）:
{{"factual": boolean, "overreach": boolean, "sufficient": boolean,
 "category": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated", "reason": "30字以内"}}"""
    resp = requests.post(JUDGE_URL,
                         headers={"Authorization": f"Bearer {ORK}",
                                  "Content-Type": "application/json"},
                         json={"model": JUDGE_MODEL, "temperature": 0,
                               "messages": [{"role": "user", "content": prompt}]},
                         timeout=120)
    m = re.search(r"\{[\s\S]*\}", resp.json()["choices"][0]["message"]["content"])
    o = json.loads(m.group(0))
    return {k: (o.get(k) in (True, "true")) for k in ("factual", "overreach", "sufficient")} | {
        "category": o.get("category", "ok"), "reason": str(o.get("reason", ""))}


def load_jsonl(path):
    return {o["id"]: o for o in (json.loads(l) for l in open(path) if l.strip())}


def load_oracle_edge(path):
    items = json.load(open(path))["items"]
    return {it["id"]: it for it in items}


def main():
    gold = load_jsonl(GOLD_PATH)                      # id -> {referencePoints, ...}
    systems = {
        "oracle_edge":  load_oracle_edge(EDGE_ORACLE),
        "oracle_cloud": load_jsonl(CLOUD_ORACLE),
        "real_edge":    load_jsonl(EDGE_REAL),
        "real_cloud":   load_jsonl(CLOUD_REAL),
    }

    # 採点対象 = real_edge の id 集合（edge想定41件）に統一
    target_ids = sorted(systems["real_edge"].keys())
    print(f"対象 id: {len(target_ids)}件")

    # 全 (system,id) を gold全refで採点。answer は各systemのものを使用。
    tasks = []
    for sys_name, d in systems.items():
        for gid in target_ids:
            if gid in d and gid in gold:
                ans = d[gid].get("answer", "")
                refs = gold[gid].get("referencePoints") or []
                tasks.append((sys_name, gid, gold[gid]["query"], ans, refs))

    print(f"judge 呼び出し: {len(tasks)}件 (全 refs=gold で統一)")

    verdicts = {s: {} for s in systems}

    def work(t):
        sys_name, gid, q, ans, refs = t
        try:
            v = judge(q, ans, refs)
        except Exception as e:
            v = {"factual": False, "sufficient": False, "overreach": False,
                 "category": "error", "reason": str(e)[:30]}
        return sys_name, gid, v

    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, (sys_name, gid, v) in enumerate(ex.map(work, tasks), 1):
            verdicts[sys_name][gid] = v
            if i % 20 == 0:
                print(f"  {i}/{len(tasks)}")

    json.dump(verdicts, open(OUT_CACHE, "w"), ensure_ascii=False, indent=2)
    print(f"[cache] {OUT_CACHE}")

    # ── 2×2 再計算 (同一judge・同一全ref) ──
    def two_by_two(oracle_v, real_v, label):
        ids = sorted(set(oracle_v) & set(real_v) & set(target_ids))
        both = ret = odd = rea = 0
        odd_ids, ret_ids = [], []
        for gid in ids:
            og = isgood(oracle_v[gid]); rg = isgood(real_v[gid])
            if og and rg: both += 1
            elif og and not rg: ret += 1; ret_ids.append(gid)
            elif not og and rg: odd += 1; odd_ids.append(gid)
            else: rea += 1
        n = len(ids)
        og_pct = (both + ret) / n * 100
        rg_pct = (both + odd) / n * 100
        print(f"\n## 2×2: {label} (n={n}, 同一judge/全ref)")
        print(f"|                | 実RAG good | 実RAG bad |")
        print(f"| Oracle good    | {both:>2} (both ok)  | {ret:>2} (retrieval failure) |")
        print(f"| Oracle bad     | {odd:>2} (検索勝ち?) | {rea:>2} (reasoning failure)  |")
        print(f"- oracle good: {both+ret}/{n} = {og_pct:.1f}%")
        print(f"- 実RAG good : {both+odd}/{n} = {rg_pct:.1f}%")
        print(f"- retrieval loss: {og_pct:.1f}% → {rg_pct:.1f}% (Δ={rg_pct-og_pct:+.1f}pts)")
        print(f"- retrieval failure: {ret}/{n} = {ret/n*100:.1f}%  ids={ret_ids}")
        print(f"- reasoning failure: {rea}/{n} = {rea/n*100:.1f}%")
        print(f"- odd(oracle bad∩real good): {odd}/{n} = {odd/n*100:.1f}%  ids={odd_ids}")
        return dict(n=n, both=both, ret=ret, odd=odd, rea=rea, og=og_pct, rg=rg_pct)

    print("\n" + "=" * 60)
    print("再採点後 2×2（answer据置・参照を全referencePointsに統一）")
    print("=" * 60)
    two_by_two(verdicts["oracle_edge"],  verdicts["real_edge"],  "EDGE (Gemma4 thinkOFF)")
    two_by_two(verdicts["oracle_cloud"], verdicts["real_cloud"], "CLOUD (deepseek-v4-flash)")

    # good 単純集計
    print("\n## good 集計（全ref採点）")
    for s in systems:
        g = sum(1 for gid in target_ids if gid in verdicts[s] and isgood(verdicts[s][gid]))
        print(f"  {s:13}: {g}/{len(target_ids)} = {g/len(target_ids)*100:.1f}%")


if __name__ == "__main__":
    main()
