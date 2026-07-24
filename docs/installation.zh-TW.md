# 安裝與生命週期

English: [installation.md](./installation.md) · [简体中文](./installation.zh.md) · [繁體中文](./installation.zh-TW.md)

## 需求

- Node.js 20 或更新
- npm
- 腳本使用的 macOS 或 Linux shell 工具
- 用於即時能力檢查與外掛使用的 Cursor Agent
- 收據式 CLI 安裝需將 `~/.local/bin` 加入 `PATH`

請依 [Cursor CLI 官方說明](https://cursor.com/docs/cli/overview) 安裝 Cursor Agent。OMCU 不會安裝或驗證 Cursor Agent。

## 從原始碼 checkout 使用

這是最簡單的開發路徑，不會建立持久 OMCU 安裝：

```sh
npm ci
npm run build
node dist/bin/omcu.js --help
node dist/bin/omcu.js capabilities discover
cursor-agent --plugin-dir "$PWD"
```

`--plugin-dir` 僅要求 Cursor Agent 在該次呼叫載入 checkout，不會修改 `~/.cursor`。

## 從原始碼安裝

生命週期安裝程式會將建置後的原始碼樹複製到不可變的外部階段，並建立指向 `~/.local/bin/omcu` 的符號連結：

```sh
npm ci
npm run build
./scripts/install.sh --source "$PWD" --project /absolute/path/to/project
```

命令會輸出包含 `receiptPath`、已安裝階段、來源摘要與 doctor 結果的 JSON。請保存收據路徑；解除安裝需要它。

預設：

- 安裝狀態：`~/.local/state/oh-my-cursor/`
- CLI 連結：`~/.local/bin/omcu`
- 專案狀態：`/absolute/path/to/project/.omcu/`

安裝狀態與專案狀態擁有不同的擁有者與生命週期。切勿將安裝收據複製到 `.omcu/`，也切勿手動編輯 `.omcu/`。

## 安裝離線 release 壓縮檔

透過可信管道取得版本化壓縮檔與其 `SHA256SUMS`。安裝程式會在解壓前驗證指名壓縮檔，並拒絕絕對路徑或 `..` 穿越條目。

若已有原始碼 checkout 或先前解壓的 release：

```sh
./scripts/install.sh \
  --archive /absolute/path/to/iml1s-oh-my-cursor-0.2.1.tgz \
  --checksums /absolute/path/to/SHA256SUMS \
  --project /absolute/path/to/project
```

首次離線安裝時，僅驗證並解壓 release 以 bootstrap 其安裝程式，再由該安裝程式再次驗證壓縮檔：

```sh
ASSET=/absolute/path/to/iml1s-oh-my-cursor-0.2.1.tgz
CHECKSUMS=/absolute/path/to/SHA256SUMS
(cd "$(dirname "$ASSET")" && shasum -a 256 -c "$CHECKSUMS")
BOOTSTRAP="$(mktemp -d)"
tar -xzf "$ASSET" -C "$BOOTSTRAP"
"$BOOTSTRAP/package/scripts/install.sh" \
  --archive "$ASSET" \
  --checksums "$CHECKSUMS" \
  --project /absolute/path/to/project
```

此路徑不會下載套件。壓縮檔須包含一個套件根目錄，內有 `package.json`、編譯後的 `dist/bin/omcu.js`、外掛表面與生命週期腳本。

## 手動載入外掛

要在不安裝 OMCU 的情況下檢視或使用可信的原始碼 checkout 或解壓 release，可為單次呼叫指定 Cursor 路徑：

```sh
cursor-agent --plugin-dir /absolute/path/to/oh-my-cursor
```

此為暫時行為，不會寫入 Cursor 使用者設定。在 Cursor 或 OMCU 收據式生命週期回報該狀態前，release 不算已安裝。

若僅要將本機 OMCU MCP 伺服器加入目前專案的 `.cursor/mcp.json`：

```sh
omcu mcp-install
```

這是明確的專案檔變更。隨附的 `.mcp.json` 預設仍為空。

## 更新

從已驗證的原始碼 checkout：

```sh
npm ci
npm run build
node dist/src/setup/script-entry.js update \
  --source "$PWD" \
  --project /absolute/path/to/project
```

從離線 release 產物：

```sh
node dist/src/setup/script-entry.js update \
  --archive /absolute/path/to/iml1s-oh-my-cursor-0.2.1.tgz \
  --checksums /absolute/path/to/SHA256SUMS \
  --project /absolute/path/to/project
```

更新會在切換 CLI 符號連結前先暫存新位元組。若暫存或安裝後 doctor 失敗，安裝程式會還原先前的連結與指標。

## Doctor 與讀回

```sh
node dist/src/setup/script-entry.js doctor \
  --package-root "$PWD" \
  --project /absolute/path/to/project
```

Doctor 會檢查外掛 manifest、Cursor 版本/狀態/help、Cursor 是否接受 `--plugin-dir`
參數（接受即為 pass；文案仍註明 session skill 啟用**不能**靠 `--help` 證明）、
rules、hooks、MCP 設定與專案狀態。軟警告**不會**讓成功的安裝/bootstrap 以非零
結束：寫入收據後安裝程式仍結束碼 `0`。單獨執行 `omcu doctor` 時仍是：乾淨 `0`、
僅警告 `2`、失敗 `1`。

對已安裝副本，使用目前收據透過 setup 函式庫驗證不可變階段位元組與 CLI 連結身分，或對收據列印的已安裝階段重複 doctor。

## 解除安裝

使用 install 或 update 回傳的**確切**收據：

```sh
./scripts/uninstall.sh \
  --receipt /absolute/path/to/receipt.json
```

解除安裝僅移除身分仍與收據相符的路徑。已修改或替換的路徑會保留並回報為碰撞。專案 `.omcu/` 預設保留。僅在仍為空時可移除：

```sh
./scripts/uninstall.sh \
  --receipt /absolute/path/to/receipt.json \
  --purge-project-state
```

腳本不會全域安裝，也不會寫入 Cursor 使用者設定。
