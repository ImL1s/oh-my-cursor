# 发布流程

English: [releasing.md](./releasing.md) · [简体中文](./releasing.zh.md) · [繁體中文](./releasing.zh-TW.md)

此流程创建 release 产物，**不**包含发布。标记、推送、包发布与市场提交为各自授权的独立动作。

## 1. 准备

确认 checkout 干净且版本一致：

```sh
git status --short
node -p "require('./package.json').version"
node -p "require('./.cursor-plugin/plugin.json').version"
node dist/bin/omcu.js --version
```

三个版本值（`package.json`、`.cursor-plugin/plugin.json` 与 CLI）必须与 release 版本相符。

审阅 `CHANGELOG.md`、`PROJECT.md`、`SECURITY.md` 与 `TEST_READY.md`。确认能力 lock 指名预期的 Cursor Agent 基线。

## 2. 构建与测试

```sh
npm ci
npm run check
node dist/bin/omcu.js --help
node dist/bin/omcu.js capabilities discover
node dist/src/setup/script-entry.js doctor \
  --package-root "$PWD" \
  --project "$PWD"
```

编译、任何测试、CLI help 或固定实时能力探测失败时**不要**打标签。doctor 警告不一定致命，但须在 `TEST_READY.md` 说明。

## 3. 检查包内容

包 manifest 为分发允许清单。确认 dry run 包含编译输出、插件表面、生命周期脚本、能力 lock、README、许可与包元数据，并排除 `.git/`、`.omcu/`、`node_modules/`、覆盖率、日志与凭据。

```sh
npm run package:dry-run
```

## 4. 创建 release 产物

```sh
VERSION="$(node -p "require('./package.json').version")"
npm run release:archive
ASSET_BASENAME="iml1s-oh-my-cursor-${VERSION}.tgz"
ASSET="release/${ASSET_BASENAME}"
CHECKSUMS="release/SHA256SUMS"
(cd release && shasum -a 256 -c SHA256SUMS)
```

`release:archive` 会创建两个文件。`SHA256SUMS` 仅包含一个仅文件名的压缩包条目；勿加入 `release/` 路径前缀。

预期产物：

- `release/iml1s-oh-my-cursor-0.2.1.tgz`
- `release/SHA256SUMS`（仅文件名的压缩包条目）

## 5. 离线测试压缩包

从 `TEST_READY.md` 运行隔离生命周期关卡，将来源安装替换为：

```sh
./scripts/install.sh \
  --archive "$PWD/release/iml1s-oh-my-cursor-${VERSION}.tgz" \
  --checksums "$PWD/release/SHA256SUMS" \
  --home "$TMP_ROOT/home" \
  --state-root "$TMP_ROOT/state" \
  --project "$TMP_ROOT/project" \
  --no-doctor
```

验证已安装的 `omcu --version`、Cursor 可用时的能力探索、更新回滚行为与收据式卸载。

## 6. 记录证据

将日期、确切 commit、Node/npm/Cursor 版本、命令退出码、测试计数、产物 SHA-256 与任何警告写入 `TEST_READY.md`。验证证据须为新鲜，且须与后续标签、推送、registry 或市场证明分开。
