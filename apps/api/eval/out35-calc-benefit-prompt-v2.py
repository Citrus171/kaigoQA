#!/usr/bin/env python3
"""out/35: system prompt V2 の効果測定。EDGE_SYSTEM_PROMPT 以外は out/34 と完全固定。
generation policy（逃げ・要約し過ぎ）が律速か、capacity 天井かを切り分ける。
"""
import json, os, time, math, re as _re, sys
import requests

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT  = os.path.join(HERE, "out")

env_path = os.path.join(HERE, "..", ".env")
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

CF_ACC       = os.environ["CF_ACCOUNT_ID"]
CF_TOK       = os.environ["CF_API_TOKEN"]
EMBED_URL    = f"https://api.cloudflare.com/client/v4/accounts/{CF_ACC}/ai/run/@cf/baai/bge-m3"

OPENCODE_KEY = os.environ["OPENCODE_API_KEY"]
OPENCODE_URL = "https://opencode.ai/zen/go/v1/chat/completions"
CLOUD_MODEL  = os.environ.get("OPENCODE_MODEL", "deepseek-v4-flash")

ORK          = os.environ["OPENROUTER_API_KEY"]
JUDGE_MODEL  = os.environ.get("JUDGE_MODEL", "openai/gpt-4o")
JUDGE_URL    = "https://openrouter.ai/api/v1/chat/completions"

GOLD_PATH    = os.path.join(DATA, "routing-gold-a.jsonl")
NEW_CACHE    = os.path.join(DATA, "rag-corpus-embeddings-qlevel-v2.json")
GEN_OUT      = os.path.join(DATA, "rag-mvp-cloud-calc-v2.jsonl")
OUT34_JSONL  = os.path.join(DATA, "rag-mvp-cloud-calc.jsonl")
RESULT_MD    = os.path.join(OUT, "35-calc-benefit-prompt-v2.md")

TARGET_IDS = [f"gold-calc-{i:03d}" for i in range(1, 21)]

EDGE_SYSTEM_PROMPT = (
    "あなたは介護施設の一次対応アシスタントです。利用者の質問に日本語で答えてください。"
    "回答の参考情報には、質問への回答に必要な事実や条件が含まれています。参考情報に単位数・金額・"
    "加算率・人員要件・算定要件・期間などの具体的な数値や条件が記載されている場合は、省略せず回答に含めてください。"
    "利用者の質問が数値・金額・加算率・算定条件を尋ねている場合、それらは回答の核心情報です。"
    "核心情報は要約や一般論に置き換えず、具体的に記載してください。"
    "「施設にご確認ください」「自治体にご確認ください」などの案内は、参考情報に回答が存在しない場合、"
    "または施設・自治体ごとに運用が異なる事項に限って使用してください。"
    "参考情報に記載されている事実や数値を、この案内によって省略してはいけません。"
    "簡潔さは保ちつつ、利用者の判断に必要な数値・条件は漏れなく回答してください。目安は3〜5文です。"
    "医療診断・投薬指示・法令の断定はしないこと。"
)

_supp_pat = _re.compile(
    r'(介護保険法第|法第\d+条|法第\d+条の\d+|老人福祉法第|'
    r'\d+年\d+月に施行|\d+年に施行|介護保険法に基づき[^、]*省令|'
    r'各事業者の指定基準は介護保険法|省令で定められ|'
    r'市区町村により異なる|事前確認を推奨|'
    r'^\d+年（平成|平成\d+年|平成9年|平成12年|'
    r'同法第|に規定$|に根拠規定がある|'
    r'に基づく$|に基づく居宅介護支援|'
    r'[、。]介護保険法第|'
    r'^★介護保険法第)')

ORACLE_GOOD_PCT = 92.7


def cos(a, b):
    d = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return d / (na * nb) if na and nb else 0.0


def load_gold():
    return {json.loads(l)["id"]: json.loads(l) for l in open(GOLD_PATH) if l.strip()}


def build_qlevel_corpus(gold_dict):
    corpus = []
    for gid, g in gold_dict.items():
        refs = g.get("referencePoints") or []
        if refs:
            text = "\n".join(refs)
            corpus.append({"src_id": gid, "text": text})
    return corpus


def embed_corpus_cf(corpus, cache_path):
    if os.path.exists(cache_path):
        print(f"[embed] cache hit: {cache_path}")
        return json.load(open(cache_path))["embeddings"]

    texts = [c["text"] for c in corpus]
    total = len(texts)
    print(f"[embed] Workers AI bge-m3: {total} chunks ...")
    t0 = time.time()

    BATCH = 100
    all_embeds = []
    for i in range(0, total, BATCH):
        batch = texts[i:i + BATCH]
        resp = requests.post(EMBED_URL,
                             headers={"Authorization": f"Bearer {CF_TOK}"},
                             json={"text": batch},
                             timeout=120)
        resp.raise_for_status()
        body = resp.json()
        if not body.get("success"):
            raise RuntimeError(f"embed error: {body.get('errors')}")
        embeds = body["result"]["data"]
        all_embeds.extend(embeds)
        elapsed = time.time() - t0
        print(f"  {min(i + BATCH, total)}/{total} ({elapsed:.0f}s)")

    json.dump({"embeddings": all_embeds}, open(cache_path, "w"), ensure_ascii=False)
    print(f"[embed] saved: {cache_path} ({time.time() - t0:.0f}s)")
    return all_embeds


def embed_query_cf(text):
    resp = requests.post(EMBED_URL,
                         headers={"Authorization": f"Bearer {CF_TOK}"},
                         json={"text": [text]},
                         timeout=60)
    resp.raise_for_status()
    return resp.json()["result"]["data"][0]


def search_top(query, corpus, corpus_embeds, k):
    q_emb = embed_query_cf(query)
    scores = [(i, cos(q_emb, ce)) for i, ce in enumerate(corpus_embeds)]
    scores.sort(key=lambda x: -x[1])
    return [(corpus[si]["src_id"], corpus[si]["text"], sc) for si, sc in scores[:k]]


def gen_cloud(query, refs):
    ref_text = "\n".join(f"- {pt}" for pt in refs)
    sys_p = EDGE_SYSTEM_PROMPT + f"\n\n回答の参考情報（介護保険の事実）:\n{ref_text}"
    r = requests.post(OPENCODE_URL,
                      headers={"Authorization": f"Bearer {OPENCODE_KEY}",
                               "Content-Type": "application/json"},
                      json={"model": CLOUD_MODEL,
                            "messages": [{"role": "system", "content": sys_p},
                                         {"role": "user", "content": query}]},
                      timeout=120)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()


def classify_tier(pt):
    if _supp_pat.search(pt):
        return "supplement"
    return "main"


def build_2axis_prompt(query, answer, refs, tiers):
    main_pts = [f"- {pt}" for pt, t in zip(refs, tiers) if t == "main"]
    supp_pts = [f"- {pt}" for pt, t in zip(refs, tiers) if t == "supplement"]

    prompt = f"""あなたは日本の介護保険制度に精通した審査員です。AIの回答を「一次対応アシスタントとして実用十分か(relaxed)」と「全要点網羅の専門的十分さ(strict)」の2軸で厳格に採点してください。

質問: {query}

★主要事実（relaxed判定で必須。利用者の行動・理解・意思決定に直結する事実）:
{chr(10).join(main_pts)}

△補足情報（relaxedでは不問。法令条番号・条文引用・年号・限度額・行政注記等の補足細目。strictでは要網羅）:
{chr(10).join(supp_pts) if supp_pts else '（なし）'}

AIの回答: {answer}

判定基準:

1. factual: 回答に事実誤認があるか（緩めず厳格に。relaxed/strict共通）
2. overreach: 医療診断・投薬指示・法令の断定をしていないか（緩めず厳格に。共通）
3. sufficient_relaxed: ★主要事実をカバーし、かつ**質問の核心＝利用者の意思決定に直結する主要事実（帰結情報）を落としていない**か。△補足情報の欠落は不問。
   → 特に注意: **calc-benefit系質問では算定要件・金額・条件が質問の核心**。これらの具体的数値の欠落や誤りは、主要事実としてrelaxedでもinsufficientとする。
4. sufficient_strict: ★主要事実＋△補足情報の全要点を網羅しているか。

次のJSONのみを返答（前置き・コードフェンス不要）:
{{"factual": boolean, "overreach": boolean, "sufficient_relaxed": boolean, "sufficient_strict": boolean,
 "category_relaxed": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated",
 "category_strict": "ok"|"hallucination"|"partial"|"refusal"|"overreach"|"outdated",
 "reason": "30字以内"}}"""
    return prompt


def judge2axis(query, answer, refs, tiers):
    prompt = build_2axis_prompt(query, answer, refs, tiers)
    resp = requests.post(JUDGE_URL,
                         headers={"Authorization": f"Bearer {ORK}",
                                  "Content-Type": "application/json"},
                         json={"model": JUDGE_MODEL, "temperature": 0,
                               "messages": [{"role": "user", "content": prompt}]},
                         timeout=120)
    m = _re.search(r"\{[\s\S]*\}", resp.json()["choices"][0]["message"]["content"])
    o = json.loads(m.group(0))
    return {
        "factual": o.get("factual") in (True, "true"),
        "overreach": o.get("overreach") in (True, "true"),
        "sufficient_relaxed": o.get("sufficient_relaxed") in (True, "true"),
        "sufficient_strict": o.get("sufficient_strict") in (True, "true"),
        "category_relaxed": o.get("category_relaxed", "ok"),
        "category_strict": o.get("category_strict", "ok"),
        "reason": str(o.get("reason", "")),
    }


def isgood_relaxed(v):
    return bool(v) and v.get("factual") and v.get("sufficient_relaxed") and not v.get("overreach")


def isgood_strict(v):
    return bool(v) and v.get("factual") and v.get("sufficient_strict") and not v.get("overreach")


def classify_bad(r):
    v = r.get("verdict") or {}
    if not r.get("gid_in_top1"):
        return "missing"
    if not v.get("factual"):
        return "misinterpreted"
    return "omitted"


def main():
    t0 = time.time()
    print(f"=== out/35: calc-benefit system prompt V2 効果測定 ===")
    print(f"model: {CLOUD_MODEL} / judge: {JUDGE_MODEL}")
    print(f"oracle baseline (easy): {ORACLE_GOOD_PCT}%")
    print(f"prompt: V2 (数値省略禁止・3〜5文)")

    gold_dict = load_gold()
    print(f"gold-a: {len(gold_dict)} questions")

    corpus = build_qlevel_corpus(gold_dict)
    print(f"q-level corpus: {len(corpus)} chunks (1q=1chunk)")
    corpus_embeds = embed_corpus_cf(corpus, NEW_CACHE)

    target_qs = [(gid, gold_dict[gid]) for gid in TARGET_IDS if gid in gold_dict]
    print(f"\n=== cloud gen + 2-axis judge: {len(target_qs)} calc-benefit questions (prompt V2) ===")

    done_ids = set()
    if os.path.exists(GEN_OUT):
        for line in open(GEN_OUT):
            if line.strip():
                done_ids.add(json.loads(line)["id"])
        print(f"  既処理スキップ: {len(done_ids)}件")

    with open(GEN_OUT, "a") as fout:
        for i, (gid, g) in enumerate(target_qs):
            if gid in done_ids:
                continue

            top = search_top(g["query"], corpus, corpus_embeds, 1)
            src_id = top[0][0] if top else ""
            chunk_text = top[0][1] if top else ""
            gid_in_top = (src_id == gid)
            ref_lines = chunk_text.split("\n") if chunk_text else []

            rec = {"id": gid, "query": g["query"], "expected": g.get("expected"),
                   "category": g.get("category"), "top1_src_id": src_id,
                   "gid_in_top1": gid_in_top}

            t_gen = time.time()
            try:
                ans = gen_cloud(g["query"], ref_lines)
                rec["genFailed"] = False
            except Exception as ex:
                ans = ""
                rec["genFailed"] = True
                rec["genError"] = str(ex)[:120]
                print(f"  [{i+1}/{len(target_qs)}] {gid} gen FAIL: {str(ex)[:80]}", flush=True)
            rec["answer"] = ans
            rec["latencyMs"] = int((time.time() - t_gen) * 1000)

            if ans:
                try:
                    refs = g.get("referencePoints") or []
                    tiers = [classify_tier(pt) for pt in refs]
                    rec["verdict"] = judge2axis(g["query"], ans, refs, tiers)
                except Exception as ex:
                    rec["verdict"] = {"factual": False, "overreach": False,
                                      "sufficient_relaxed": False, "sufficient_strict": False,
                                      "category_relaxed": "error", "category_strict": "error",
                                      "reason": str(ex)[:30]}
                    rec["judgeError"] = str(ex)[:120]
            else:
                rec["verdict"] = {"factual": False, "overreach": False,
                                  "sufficient_relaxed": False, "sufficient_strict": False,
                                  "category_relaxed": "no_answer", "category_strict": "no_answer",
                                  "reason": "生成失敗"}

            rec["good_relaxed"] = isgood_relaxed(rec["verdict"])
            rec["good_strict"] = isgood_strict(rec["verdict"])

            fout.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fout.flush()

            gr = "G" if rec["good_relaxed"] else "."
            gs = "G" if rec["good_strict"] else "."
            v = rec["verdict"]
            bc = classify_bad(rec) if not rec["good_relaxed"] else "-"
            print(f"  [{i+1}/{len(target_qs)}] {gid} relaxed={gr} strict={gs} "
                  f"{rec['latencyMs']}ms (top1={src_id}, hit={'Y' if gid_in_top else 'N'}) "
                  f"bad={bc} {v.get('reason','')[:40]}", flush=True)
            time.sleep(0.2)

    rows = [json.loads(l) for l in open(GEN_OUT) if l.strip()]
    n = len(rows)
    good_r = sum(1 for r in rows if r.get("good_relaxed"))
    good_s = sum(1 for r in rows if r.get("good_strict"))
    r_pct = good_r / n * 100
    s_pct = good_s / n * 100

    print(f"\n=== results ===")
    print(f"relaxed good: {good_r}/{n} = {r_pct:.1f}%")
    print(f"strict good: {good_s}/{n} = {s_pct:.1f}%")

    if r_pct > ORACLE_GOOD_PCT + 1:
        print(f"\n  ⚠️ GUARD: real relaxed ({r_pct:.1f}%) > oracle ({ORACLE_GOOD_PCT}%). 停止。")
        sys.exit(1)

    # 3-classification bad analysis
    bad_r = [r for r in rows if not r.get("good_relaxed")]
    bc_counts = {"missing": 0, "misinterpreted": 0, "omitted": 0}
    for r in bad_r:
        c = classify_bad(r)
        bc_counts[c] += 1
    assert sum(bc_counts.values()) == len(bad_r), f"3分類合計不一致: {bc_counts} vs {len(bad_r)}"

    print(f"\nbad 3分類 (relaxed bad={len(bad_r)}件):")
    print(f"  missing: {bc_counts['missing']}")
    print(f"  misinterpreted: {bc_counts['misinterpreted']}")
    print(f"  omitted: {bc_counts['omitted']}")

    retrieval_fail = bc_counts["missing"]
    factual_err = sum(1 for r in rows if not (r.get("verdict") or {}).get("factual"))
    reasoning_fail = len(bad_r) - retrieval_fail
    good_hit = sum(1 for r in rows if r.get("gid_in_top1"))
    overreach_n = sum(1 for r in rows if (r.get("verdict") or {}).get("overreach"))

    print(f"\ntop-1 gid hit rate: {good_hit}/{n} = {good_hit/n*100:.1f}%")
    print(f"factual errors: {factual_err}/{n}")
    print(f"overreach: {overreach_n}/{n}")

    # Load out/34 for comparison
    out34 = {}
    if os.path.exists(OUT34_JSONL):
        for line in open(OUT34_JSONL):
            if line.strip():
                o = json.loads(line)
                out34[o["id"]] = o

    # Per-item diff
    improved = []
    regressed = []
    unchanged_bad = []
    for r in rows:
        gid = r["id"]
        o34 = out34.get(gid, {})
        r34_good = o34.get("good_relaxed", False)
        r35_good = r.get("good_relaxed", False)
        if r35_good and not r34_good:
            improved.append(gid)
        elif r34_good and not r35_good:
            regressed.append(gid)
        elif not r35_good and not r34_good:
            bc34 = classify_bad(o34) if o34 else "?"
            bc35 = classify_bad(r)
            unchanged_bad.append((gid, bc34, bc35, (o34.get("verdict") or {}).get("reason", ""), (r.get("verdict") or {}).get("reason", "")))

    elapsed = time.time() - t0

    # Write report
    md = []
    md.append("# 35: calc-benefit system prompt V2 効果測定")
    md.append("")
    md.append(f"`{time.strftime('%Y-%m-%d %H:%M')}` / elapsed={elapsed:.0f}s")
    md.append("")
    md.append("## 背景")
    md.append("")
    md.append("- out/34: calc-benefit 20件 relaxed 55.0%。retrieval 95% hit で健全、律速は generation")
    md.append("- 主な失敗パターン: 数値省略（5件）・「施設にご確認」逃げ")
    md.append("- 本レポート: system prompt のみ V2 に変更し、同一基盤で効果を測定")
    md.append("- 目的: **generation policy（promptで直る）か capacity 天井（モデル限界）か** を切り分け")
    md.append("")
    md.append("## 変更点（out/34 からの差分）")
    md.append("")
    md.append("- `EDGE_SYSTEM_PROMPT` を V2 に差し替え（数値省略禁止・核心情報具体化・『施設にご確認』抑制・3〜5文）")
    md.append("- 出力先を `rag-mvp-cloud-calc-v2.jsonl` / `out/35-*.md` に分離")
    md.append("- embed cache は `rag-corpus-embeddings-qlevel-v2.json`(135chunk) を再利用（cache hit）")
    md.append("- judge / 検索 / 対象20件 / モデル / oracle基準 は完全固定")
    md.append("")
    md.append("## system prompt V2")
    md.append("")
    md.append("```")
    md.append(EDGE_SYSTEM_PROMPT)
    md.append("```")
    md.append("")
    md.append("## 構成")
    md.append("")
    md.append(f"- corpus: q-level {len(corpus)} chunks (gold-a 135件)")
    md.append(f"- embed: `@cf/baai/bge-m3` (Workers AI, dim=1024) — cache hit")
    md.append(f"- search: top-1 q-level chunk")
    md.append(f"- cloud: {CLOUD_MODEL} (OpenCode)")
    md.append(f"- judge: {JUDGE_MODEL} (OpenRouter, temp=0, 2軸, 全ref=gold)")
    md.append(f"- 評価対象: {n}件 (calc-benefit 18 + boundary 2)")
    md.append(f"- oracle baseline: easy {ORACLE_GOOD_PCT}% (out/33)")
    md.append("")

    # Load out34 aggregate numbers for comparison
    out34_good_r = sum(1 for r in out34.values() if r.get("good_relaxed")) if out34 else 11
    out34_good_s = sum(1 for r in out34.values() if r.get("good_strict")) if out34 else 8
    out34_r_pct = out34_good_r / len(out34) * 100 if out34 else 55.0
    out34_s_pct = out34_good_s / len(out34) * 100 if out34 else 40.0

    md.append("## 結果")
    md.append("")
    md.append("| 指標 | out/34 (V1) | out/35 (V2) | 改善 |")
    md.append("|---|---|---|---|")
    md.append(f"| relaxed good | {out34_good_r}/20 = {out34_r_pct:.1f}% | {good_r}/20 = **{r_pct:.1f}%** | {r_pct - out34_r_pct:+.1f}pt |")
    md.append(f"| strict good | {out34_good_s}/20 = {out34_s_pct:.1f}% | {good_s}/20 = {s_pct:.1f}% | {s_pct - out34_s_pct:+.1f}pt |")
    md.append(f"| top-1 hit率 | 95.0% | {good_hit/n*100:.1f}% | — |")
    md.append(f"| overreach | 0/20 | {overreach_n}/20 | — |")
    md.append("")
    md.append(f"- easy baseline: {ORACLE_GOOD_PCT}%。差分（easy - calc V2）= **{ORACLE_GOOD_PCT - r_pct:.1f}pt**")

    # 3-classification comparison
    out34_bc = {"missing": 0, "misinterpreted": 0, "omitted": 0}
    if out34:
        for r in out34.values():
            if not r.get("good_relaxed"):
                c = classify_bad(r)
                out34_bc[c] += 1
    else:
        out34_bc = {"missing": 1, "misinterpreted": 1, "omitted": 7}

    md.append("")
    md.append("### bad 3分類 推移（relaxed bad の内訳）")
    md.append("")
    md.append("| 分類 | 定義 | out/34 | out/35 | 差分 |")
    md.append("|---|---|---|---|---|")
    for cat in ["missing", "misinterpreted", "omitted"]:
        d = bc_counts[cat] - out34_bc[cat]
        md.append(f"| {cat} | {'不hit' if cat=='missing' else 'not factual' if cat=='misinterpreted' else 'hit & factual'} | {out34_bc[cat]} | {bc_counts[cat]} | {d:+d} |")
    md.append(f"| **合計** | | **{sum(out34_bc.values())}** | **{len(bad_r)}** | **{len(bad_r) - sum(out34_bc.values()):+d}** |")
    md.append("")

    omitted_delta = bc_counts["omitted"] - out34_bc["omitted"]
    misinterpreted_delta = bc_counts["misinterpreted"] - out34_bc["misinterpreted"]

    md.append(f"**omitted 差分: {omitted_delta:+d}件** ← prompt V2 成否の主指標")
    if omitted_delta < 0:
        md.append(f"- V2 で omitted が {abs(omitted_delta)}件 減少。数値省略抑制が機能している")
    elif omitted_delta == 0:
        md.append("- V2 で omitted 不変。prompt policy 以外の要因（generation capacity）が天井")
    else:
        md.append(f"- ⚠️ omitted が {omitted_delta}件 増加。V2 が逆効果の可能性")

    md.append(f"**misinterpreted 差分: {misinterpreted_delta:+d}件** — 数値強制で hallucination が増えていないか監視")
    if misinterpreted_delta > 0:
        md.append(f"- ⚠️ misinterpreted が {misinterpreted_delta}件 増加。数値強制が hallucination を誘発している可能性")
    md.append("")

    # Per-item diff table
    md.append("### 件別 diff（out/34 → out/35）")
    md.append("")
    md.append("| id | out34 relaxed | out35 relaxed | out35 3分類 | out34 reason | out35 reason |")
    md.append("|---|---|---|---|---|---|")
    for r in rows:
        gid = r["id"]
        o34 = out34.get(gid, {})
        r34 = "G" if o34.get("good_relaxed") else "▪"
        r35 = "G" if r.get("good_relaxed") else "▪"
        bc35 = classify_bad(r) if not r.get("good_relaxed") else "-"
        v34 = o34.get("verdict") or {}
        v35 = r.get("verdict") or {}
        md.append(f"| {gid} | {r34} | {r35} | {bc35} | {v34.get('reason','')[:30]} | {v35.get('reason','')[:30]} |")
    md.append("")

    diff_sym = {gid: "+" for gid in improved}
    for gid in regressed:
        diff_sym[gid] = "−"
    for gid, _, _, _, _ in unchanged_bad:
        diff_sym.setdefault(gid, "=")
    md.append(f"改善: {improved} ({len(improved)}件)")
    md.append(f"悪化: {regressed} ({len(regressed)}件)")
    md.append(f"不変bad: {unchanged_bad} ({len(unchanged_bad)}件)")
    md.append("")

    md.append("## 考察")
    md.append("")

    if len(improved) >= 5 and omitted_delta < -2:
        md.append(f"- **prompt V2 は有効**: relaxed {r_pct:.1f}% (out/34 {out34_r_pct:.1f}% から +{r_pct - out34_r_pct:.1f}pt), omitted {omitted_delta:+d}件, {len(improved)}件改善")
        md.append(f"- 結論: calc-benefit の新律速は **generation policy（逃げ・要約し過ぎ）**。prompt で解決")
        md.append(f"- → 本番 `apps/api/eval/rag-mvp.py` の `EDGE_SYSTEM` へ V2 を反映を推奨")
    elif len(improved) >= 1:
        md.append(f"- **prompt V2 は部分改善**: relaxed {r_pct:.1f}% (out/34 {out34_r_pct:.1f}% から +{r_pct - out34_r_pct:.1f}pt), {len(improved)}件改善/{len(unchanged_bad)}件不変bad")
        if omitted_delta < 0:
            md.append(f"- omitted が {abs(omitted_delta)}件 減少。数値省略抑制は一部有効だが残存あり")
        md.append(f"- 結論: generation policy の改善と capacity 天井の両方。prompt改善＋RAG構成/モデル検討の二段構え")
    else:
        md.append(f"- **prompt V2 は無効**: relaxed {r_pct:.1f}%、改善0件")
        if omitted_delta <= 0:
            md.append(f"- 結論: calc-benefit の律速は **generation capacity 天井**（モデル限界）。prompt では直らない")
            md.append(f"- → 次は RAG 構成（参考情報の渡し方）・モデル選定（より強力なモデル）へ")

    md.append("")
    md.append(f"- easy baseline {ORACLE_GOOD_PCT}% との差 {ORACLE_GOOD_PCT - r_pct:.1f}pt（out/34: {ORACLE_GOOD_PCT - out34_r_pct:.1f}pt）")

    report = "\n".join(md)
    os.makedirs(os.path.dirname(RESULT_MD), exist_ok=True)
    with open(RESULT_MD, "w") as f:
        f.write(report)
    print(f"\n[out] {RESULT_MD}")
    print(report)
    print(f"\n[DONE] elapsed={elapsed:.0f}s")


if __name__ == "__main__":
    main()
