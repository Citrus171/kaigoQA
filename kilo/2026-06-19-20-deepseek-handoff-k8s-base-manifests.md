# DeepSeek handoff #20: k8s base マニフェスト初版生成（k3d 用 dev overlay まで）

作成 2026-06-19 / Claude → Kilo(DeepSeek)。フェーズ2(タスクA=Hono `/ai/qa` に Capability Router+RAG 配線)完了を受け、タスクB(k3d/k8s)に着手。Dockerfile は api/web とも完成済み(build成功・`/health` 200 確認済)。本handoffは **`deploy/` 配下の k8s マニフェスト雛形を生成する**こと。仕様は `docs/k8s-migration-plan.md` §2〜§4 で確定済み。

## ゴール
`docs/k8s-migration-plan.md` §4 の構成に沿って、**Kustomize base + overlays/dev(k3d用)** の YAML 雛形一式を `deploy/` に生成する。**k3d(ローカル・CPUのみ)で `kustomize build` が通り、api/web/postgres/ollama が起動して `/health` と `/ai/qa` が疎通する**ことを目標にした初版。

## 🔴 鉄則
- **アプリコード・Dockerfile は一切変更しない**。マニジェストは既存 Dockerfile の契約(下記)に**合わせる**。
- **Secret に実値を書かない**。`stringData` にプレースホルダ(`REPLACE_ME`)を置き、`secret.example.yaml` として出力。実値投入手順はコメントで明記。
- **dev overlay は CPU のみ・GPU リソース要求を書かない**(`nvidia.com/gpu` 禁止)。理由: edge生成Gemma4はCPU 0.36 tok/s で実用不可(2026-06-18実測)、k3dローカルは「埋め込み+配線確認」限定。
- **`deploy/` は git 追跡対象**(`docs/` と違い gitignore しない)。
- 2回試して通らない構成はバグ報告に切り替える(無限ループ禁止)。

## 既存 Dockerfile の契約(これに合わせる)
| | api (`apps/api/Dockerfile`) | web (`apps/web/Dockerfile`) |
|---|---|---|
| ベース | node:22-slim | node:22-slim |
| EXPOSE | **8787** | **3000** |
| CMD | `npm run start`(=`tsx src/dev.ts`) | `node apps/web/server.js` |
| USER | node | node |
| build context | **リポジトリ root**(`docker build -f apps/api/Dockerfile -t hybrid-api:dev .`) | 同左 hybrid-web:dev |

## env / 設定(コンテナに注入する値)
### api Deployment が要する env
- **Secret** 由来: `DATABASE_URL`, `JWT_SECRET`, `OPENCODE_API_KEY`, `CF_ACCOUNT_ID`, `CF_API_TOKEN`(/ai/qa の RAG 埋め込みに必須), `OPENROUTER_API_KEY`(eval judge用・任意)
- **ConfigMap** 由来: `OLLAMA_URL=http://ollama:11434`, `OLLAMA_EMBED_MODEL=bge-m3`, `AI_ROUTER=classifier`, `AI_ROUTER_THRESHOLD=0`
- `DATABASE_URL` = `postgresql://app:app@postgres:5432/functest_hono`(クラスタ内 Service 名 `postgres`)
### web Deployment が要する env
- `API_ORIGIN=http://api:8787`(ConfigMap)
### postgres(StatefulSet, dev)
- `POSTGRES_USER=app` / `POSTGRES_PASSWORD=app` / `POSTGRES_DB=functest_hono`(既存 docker-compose と一致)
- PVC で `/var/lib/postgresql/data` 永続化
### ollama(Deployment, dev)
- image `ollama/ollama`、Service `ollama:11434`、PVC で `/root/.ollama` 永続化
- **initContainer or postStart で `ollama pull bge-m3`**(分類器の埋め込み用。CPUで可)
- ※ k3dローカルでは bge-m3 埋め込みのみ。edge生成(llama3.2:1b)も小型でCPU可だが初版は分類器の bge-m3 を最優先

## 成果物(生成するファイル)
```
deploy/
  base/
    kustomization.yaml          # 下記 resources を列挙
    configmap.yaml              # 非機密設定(上記 ConfigMap 値)
    secret.example.yaml         # stringData=REPLACE_ME のテンプレ。実値は別途
    api-deployment.yaml         # envFrom: configMapRef + secretRef、readinessProbe=GET /health(8787)、livenessProbe=GET /health
    api-service.yaml            # ClusterIP :8787
    web-deployment.yaml         # env API_ORIGIN、readinessProbe=GET /(3000)
    web-service.yaml            # ClusterIP :3000
    postgres-statefulset.yaml   # PVC、readinessProbe=pg_isready
    postgres-service.yaml       # ClusterIP :5432(Headless可)
    ollama-deployment.yaml      # PVC、initContainer で bge-m3 pull、readinessProbe=GET /api/tags(11434)
    ollama-service.yaml         # ClusterIP :11434
  overlays/
    dev/
      kustomization.yaml        # bases: ../../base、namespace、images(hybrid-api:dev/hybrid-web:dev)、replicas=1、imagePullPolicy=IfNotPresent への patch
  README.md                     # k3d 立ち上げ手順(下記コマンド列)
```
> prod overlay は**作らない**(本handoffは k3d 配線確認まで)。Ingress も初版は**作らない**(疎通は `kubectl port-forward` で行う)。ArgoCD(§5)も対象外。

### README.md に載せる k3d 手順(雛形でよい)
```bash
k3d cluster create kaigo --agents 1
# イメージを build して k3d に import
docker build -f apps/api/Dockerfile -t hybrid-api:dev .
docker build -f apps/web/Dockerfile -t hybrid-web:dev .
k3d image import hybrid-api:dev hybrid-web:dev -c kaigo
# Secret 実値を投入(secret.example.yaml をコピーして埋める)
kustomize build deploy/overlays/dev | kubectl apply -f -
# DB スキーマ反映(Drizzle)は Job 化前は手動: kubectl exec で npm run db:push でも可
kubectl port-forward svc/api 8787:8787 &
curl localhost:8787/health
```

## 合格条件(初版として満たすべき点)
1. `kustomize build deploy/overlays/dev` が**エラーなく出力**される(apiVersion/種別/必須フィールド充足)。
2. api Deployment の env が Secret/ConfigMap を**過不足なく参照**(特に `CF_ACCOUNT_ID`/`CF_API_TOKEN`/`OPENCODE_API_KEY` 欠落=`/ai/qa` が落ちる)。
3. Service 名・ポートが env の参照先と一致(`postgres:5432` / `ollama:11434` / `api:8787`)。
4. readiness/liveness probe が各コンテナの実ポート・実パスを指す(api=`/health`:8787、ollama=`/api/tags`:11434、postgres=`pg_isready`)。
5. dev overlay で replica=1・imagePullPolicy=IfNotPresent・GPU要求なし。

## やらないこと
- アプリコード/Dockerfile の改変。
- 実 Secret 値の記載。
- prod overlay / Ingress / ArgoCD / HPA / CronJob(eval)。
- GPU ノード前提の記述(dev は CPU のみ)。
- k3d の実起動・疎通検証(=Claude が後段で実施)。

## 完了後(Claude が実施)
1. **機械検算**: `kustomize build` 通過確認、env⇄Secret/ConfigMap の名前突合、Service名/ポート整合、probe パス/ポートが Dockerfile EXPOSE と一致。
2. **k3d 疎通検証**: クラスタ起動→image import→apply→`/health` 200 と **`/ai/qa` の2ルート(knowledge_qa/escalate)疎通**を確認(=タスクB の配線確認ゴール)。
3. ユーザー承認 → `deploy/` をコミット。

## 参考(リポジトリ内)
- `docs/k8s-migration-plan.md` §2(コンテナ化)/§3(k3d)/§4(マニフェスト構成)/§8(未決事項)
- `apps/api/Dockerfile` / `apps/web/Dockerfile`(契約の一次情報)
- `apps/api/src/app.ts`(`/health` は DB `select 1` 疎通込み)
- `apps/api/docker-compose.yml`(postgres の user/pass/db の正)
