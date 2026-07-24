# 發布流程

English: [releasing.md](./releasing.md) · [简体中文](./releasing.zh.md) · [繁體中文](./releasing.zh-TW.md)

此流程建立 release 產物，**不**包含發布。標記、推送、套件發布與市集提交為各自授權的獨立動作。

## 1. 準備

確認 checkout 乾淨且版本一致：

```sh
git status --short
node -p "require('./package.json').version"
node -p "require('./.cursor-plugin/plugin.json').version"
node dist/bin/omcu.js --version
```

三個版本值（`package.json`、`.cursor-plugin/plugin.json` 與 CLI）必須與 release 版本相符。

審閱 `CHANGELOG.md`、`PROJECT.md`、`SECURITY.md` 與 `TEST_READY.md`。確認能力 lock 指名預期的 Cursor Agent 基線。

## 2. 建置與測試

```sh
npm ci
npm run check
node dist/bin/omcu.js --help
node dist/bin/omcu.js capabilities discover
node dist/src/setup/script-entry.js doctor \
  --package-root "$PWD" \
  --project "$PWD"
```

編譯、任何測試、CLI help 或釘選即時能力探測失敗時**不要**打標籤。doctor 警告不一定致命，但須在 `TEST_READY.md` 說明。

## 3. 檢查套件內容

套件 manifest 為分發允許清單。確認 dry run 包含編譯輸出、外掛表面、生命週期腳本、能力 lock、README、授權與套件中繼資料，並排除 `.git/`、`.omcu/`、`node_modules/`、覆蓋率、日誌與憑證。

```sh
npm run package:dry-run
```

## 4. 建立 release 產物

```sh
VERSION="$(node -p "require('./package.json').version")"
npm run release:archive
ASSET_BASENAME="iml1s-oh-my-cursor-${VERSION}.tgz"
ASSET="release/${ASSET_BASENAME}"
CHECKSUMS="release/SHA256SUMS"
(cd release && shasum -a 256 -c SHA256SUMS)
```

`release:archive` 會建立兩個檔案。`SHA256SUMS` 僅包含一個僅檔名的壓縮檔條目；勿加入 `release/` 路徑前綴。

預期產物：

- `release/iml1s-oh-my-cursor-0.2.1.tgz`
- `release/SHA256SUMS`（僅檔名的壓縮檔條目）

## 5. 離線測試壓縮檔

從 `TEST_READY.md` 執行隔離生命週期關卡，將來源安裝替換為：

```sh
./scripts/install.sh \
  --archive "$PWD/release/iml1s-oh-my-cursor-${VERSION}.tgz" \
  --checksums "$PWD/release/SHA256SUMS" \
  --home "$TMP_ROOT/home" \
  --state-root "$TMP_ROOT/state" \
  --project "$TMP_ROOT/project" \
  --no-doctor
```

驗證已安裝的 `omcu --version`、Cursor 可用時的能力探索、更新回滾行為與收據式解除安裝。

## 6. 記錄證據

將日期、確切 commit、Node/npm/Cursor 版本、命令結束碼、測試計數、產物 SHA-256 與任何警告寫入 `TEST_READY.md`。驗證證據須為新鮮，且須與後續標籤、推送、registry 或市集證明分開。
