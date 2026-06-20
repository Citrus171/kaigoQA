# k8s マニフェスト（Kustomize base + dev overlay）

k3d ローカルクラスタ向け。`deploy/` は git 追跡対象。

## 構成

```
deploy/
  base/           # 共通マニフェスト (api, web, postgres, ollama)
  overlays/
    dev/          # k3d 用オーバーレイ (replica=1, imagePullPolicy=IfNotPresent, CPU only)
```

## 前提

- Docker イメージがビルド済みであること (`hybrid-api:dev`, `hybrid-web:dev`)
- `k3d` がインストールされていること
- `kustomize` がインストールされていること (`kubectl kustomize` でも可)

## k3d 起動手順

### 1. クラスタ作成

```bash
k3d cluster create kaigo --agents 1
```

### 2. イメージビルドとインポート

```bash
# リポジトリ root からビルド
docker build -f apps/api/Dockerfile -t hybrid-api:dev .
docker build -f apps/web/Dockerfile -t hybrid-web:dev .

# k3d にインポート
k3d image import hybrid-api:dev hybrid-web:dev -c kaigo
```

### 3. Secret 実値投入

```bash
cp deploy/base/secret.example.yaml deploy/base/secret.yaml

# secret.yaml の REPLACE_ME を実値に置き換え:
#   DATABASE_URL=postgresql://app:app@postgres:5432/functest_hono
#   JWT_SECRET=<任意の秘密鍵>
#   OPENCODE_API_KEY=<実キー>
#   CF_ACCOUNT_ID=<Cloudflare Account ID>
#   CF_API_TOKEN=<Cloudflare API Token>
#   OPENROUTER_API_KEY=<OpenRouter API Key（任意）>

# secret.yaml を base/kustomization.yaml の secret.example.yaml と差し替えるか、
# dev overlay の resources に直接追加する
```

### 4. デプロイ

```bash
kubectl create namespace kaigo --dry-run=client -o yaml | kubectl apply -f -
kustomize build deploy/overlays/dev | kubectl apply -f -
```

### 5. DB スキーマ反映（Drizzle）

```bash
# Job 化前の手動手順
kubectl wait --for=condition=ready pod -l app=api -n kaigo --timeout=120s
kubectl exec -n kaigo deploy/api -- npm run db:push -w @hybrid/api
# デモ/admin ユーザー投入（/auth/login・/ai/* の検証に必須）
kubectl exec -n kaigo deploy/api -- npm run db:seed -w @hybrid/api
```

### 6. 疎通確認

```bash
kubectl port-forward -n kaigo svc/api 8787:8787 &
curl http://localhost:8787/health

# AI ルート（要ログイン。demo@example.com / password）
TOKEN=$(curl -s -X POST http://localhost:8787/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","password":"password"}' | jq -r .token)
curl -s -X POST http://localhost:8787/ai/qa -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"question":"福祉用具貸与の手続きを教えて"}' | jq

kubectl port-forward -n kaigo svc/web 3000:3000 &
curl http://localhost:3000
```

### 7. 後始末

```bash
k3d cluster delete kaigo
```

## 検証

```bash
kustomize build deploy/overlays/dev
# エラーなくマニフェストが出力されれば OK
```
