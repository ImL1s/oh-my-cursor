# 安装与生命周期

English: [installation.md](./installation.md) · [简体中文](./installation.zh.md) · [繁體中文](./installation.zh-TW.md)

## 需求

- Node.js 20 或更新
- npm
- 脚本使用的 macOS 或 Linux shell 工具
- 用于实时能力检查与插件使用的 Cursor Agent
- 收据式 CLI 安装需将 `~/.local/bin` 加入 `PATH`

请按 [Cursor CLI 官方说明](https://cursor.com/docs/cli/overview) 安装 Cursor Agent。OMCU 不会安装或验证 Cursor Agent。

## 从源码 checkout 使用

这是最简单的开发路径，不会创建持久 OMCU 安装：

```sh
npm ci
npm run build
node dist/bin/omcu.js --help
node dist/bin/omcu.js capabilities discover
cursor-agent --plugin-dir "$PWD"
```

`--plugin-dir` 仅要求 Cursor Agent 在该次调用加载 checkout，不会修改 `~/.cursor`。

## 从源码安装

生命周期安装程序会将构建后的源码树复制到不可变的外部阶段，并创建指向 `~/.local/bin/omcu` 的符号链接：

```sh
npm ci
npm run build
./scripts/install.sh --source "$PWD" --project /absolute/path/to/project
```

命令会输出包含 `receiptPath`、已安装阶段、来源摘要与 doctor 结果的 JSON。请保存收据路径；卸载需要它。

默认：

- 安装状态：`~/.local/state/oh-my-cursor/`
- CLI 链接：`~/.local/bin/omcu`
- 项目状态：`/absolute/path/to/project/.omcu/`

安装状态与项目状态拥有不同的所有者与生命周期。切勿将安装收据复制到 `.omcu/`，也切勿手动编辑 `.omcu/`。

## 安装离线 release 压缩包

通过可信渠道取得版本化压缩包与其 `SHA256SUMS`。安装程序会在解压前验证指名压缩包，并拒绝绝对路径或 `..` 穿越条目。

若已有源码 checkout 或先前解压的 release：

```sh
./scripts/install.sh \
  --archive /absolute/path/to/iml1s-oh-my-cursor-0.2.1.tgz \
  --checksums /absolute/path/to/SHA256SUMS \
  --project /absolute/path/to/project
```

首次离线安装时，仅校验并解压 release 以 bootstrap 其安装程序，再由该安装程序再次校验压缩包：

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

此路径不会下载包。压缩包须包含一个包根目录，内有 `package.json`、编译后的 `dist/bin/omcu.js`、插件表面与生命周期脚本。

## 手动加载插件

要在不安装 OMCU 的情况下查看或使用可信的源码 checkout 或解压 release，可为单次调用指定 Cursor 路径：

```sh
cursor-agent --plugin-dir /absolute/path/to/oh-my-cursor
```

此为临时行为，不会写入 Cursor 用户配置。在 Cursor 或 OMCU 收据式生命周期报告该状态前，release 不算已安装。

若仅要将本地 OMCU MCP 服务器加入当前项目的 `.cursor/mcp.json`：

```sh
omcu mcp-install
```

这是明确的项目文件变更。随附的 `.mcp.json` 默认仍为空。

## 更新

从已验证的源码 checkout：

```sh
npm ci
npm run build
node dist/src/setup/script-entry.js update \
  --source "$PWD" \
  --project /absolute/path/to/project
```

从离线 release 产物：

```sh
node dist/src/setup/script-entry.js update \
  --archive /absolute/path/to/iml1s-oh-my-cursor-0.2.1.tgz \
  --checksums /absolute/path/to/SHA256SUMS \
  --project /absolute/path/to/project
```

更新会在切换 CLI 符号链接前先暂存新字节。若暂存或安装后 doctor 失败，安装程序会还原先前的链接与指针。

## Doctor 与读回

```sh
node dist/src/setup/script-entry.js doctor \
  --package-root "$PWD" \
  --project /absolute/path/to/project
```

Doctor 会检查插件 manifest、Cursor 版本/状态/help、Cursor 是否接受 `--plugin-dir`
参数（接受即为 pass；文案仍注明 session skill 启用**不能**靠 `--help` 证明）、
rules、hooks、MCP 配置与项目状态。软警告**不会**让成功的安装/bootstrap 以非零
退出：写入收据后安装程序仍退出 `0`。单独运行 `omcu doctor` 时仍是：干净 `0`、
仅警告 `2`、失败 `1`。

对已安装副本，使用当前收据通过 setup 库验证不可变阶段字节与 CLI 链接身份，或对收据打印的已安装阶段重复 doctor。

## 卸载

使用 install 或 update 返回的**确切**收据：

```sh
./scripts/uninstall.sh \
  --receipt /absolute/path/to/receipt.json
```

卸载仅移除身份仍与收据相符的路径。已修改或替换的路径会保留并报告为碰撞。项目 `.omcu/` 默认保留。仅在仍为空时可移除：

```sh
./scripts/uninstall.sh \
  --receipt /absolute/path/to/receipt.json \
  --purge-project-state
```

脚本不会全局安装，也不会写入 Cursor 用户配置。
