# CorpusEditor

<div align="center">
    <img src="resources/logo-128.png" alt="CorpusEditor Logo" width="120" height="120" style="border-radius: 24px; box-shadow: 0 10px 30px rgba(255,255,255,0.15);">
</div>

LLM 指令微调数据编辑器 —— 只读导入、逐条编辑、批量替换，进度可恢复，且永不动你的源文件。

[English](./README.md) | 简体中文

![Version](https://img.shields.io/badge/version-1.0.0-blue) ![Electron](https://img.shields.io/badge/Electron-44-47848f) ![React](https://img.shields.io/badge/React-19-61dafb) ![TypeScript](https://img.shields.io/badge/TypeScript-7-3178c6) [![License](https://img.shields.io/badge/license-MIT-green)](./LICENSE) [![CI](https://github.com/Mokuringo/CorpusEditor/actions/workflows/ci.yml/badge.svg)](https://github.com/Mokuringo/CorpusEditor/actions/workflows/ci.yml)

> 本项目**所有代码均由 AI 生成**，不含任何人工编写的代码，也未经任何人工审查。请在充分理解风险的前提下使用。

## 项目简介

CorpusEditor 是一款面向 **LLM 指令微调数据集**（SFT / DPO）的桌面端编辑器。它以只读方式打开你的数据集，支持逐条或批量校订，并导出一份干净的结果——**原始文件永不被修改**。

微调数据集往往又大又脏：你需要逐条校对、批量改写 prompt，再把结果安全地导出，同时绝不能碰坏原始数据。这正是 CorpusEditor 要解决的问题。

## 核心特性

- **只读导入。** 源文件以只读方式打开。CorpusEditor 只把*改动*（补丁）记进独立的工作区，导出时另存为全新文件。
- **逐条编辑。** 每条记录的每个字段都可在清晰、虚拟化的编辑器里修改。
- **批量替换。** 全局查找替换，也可按**字段**或按**对话角色**（system / user / assistant / tool）定向替换。
- **进度可恢复。** 改动按源文件保存在工作区。再次打开同一文件即还原进度；异常退出也能接着改。
- **多格式。** JSONL、JSON 数组、CSV、YAML、Parquet 读入；干净数据导出。
- **标记删除。** 把记录标记为「导出时跳过」，而不动源文件里的任何数据。
- **亮 / 暗主题。** 现代化界面，跟随系统或手动切换。
- **源文件完整性。** 用 SHA-256 指纹校验，证明源文件未被改动。

## 界面导览

![核心编辑页](docs/editor-zh.png)

*核心编辑页：虚拟化的记录列表、逐字段编辑、按角色着色的消息色带。*

## 支持的格式

| 格式 | 扩展名 | 说明 |
|---|---|---|
| JSONL / NDJSON | `.jsonl` `.ndjson` `.jl` | 每行一个 JSON 对象 |
| JSON | `.json` | 对象数组 |
| CSV / TSV | `.csv` `.tsv` `.tab` | 表头行映射为字段 |
| YAML | `.yaml` `.yml` | 映射组成的数组 |
| Parquet | `.parquet` | 列式存储；只读导入 |

## 快速开始

### 下载预编译包

前往 [Releases](https://github.com/Mokuringo/CorpusEditor/releases) 页面，下载对应平台的安装包。

### 从源码构建

环境要求：**Node 22+** 与 npm。

```bash
git clone https://github.com/Mokuringo/CorpusEditor.git
cd CorpusEditor
npm install
npm run build
npm start
```

## 构建与打包

```bash
npm run build      # electron-vite build → out/
npm run dist       # electron-builder → 安装包输出到 dist/
```

## 技术架构

三层，界限严格。渲染进程不碰文件系统，一切 IO 都走 `window.corpuseditor`。

```mermaid
flowchart TB
    SRC[("源文件<br/>只读 · 永不写入")]
    SES[("会话文件<br/>只存改动")]
    OUT[("导出文件")]

    subgraph UI["渲染进程 · src/"]
        Z["store.ts（zustand）<br/>唯一状态源"]
        RL["RecordList<br/>虚拟化记录列表"]
        RE["RecordEditor<br/>逐字段编辑"]
        RP["ReplacePanel<br/>全局 / 按字段 / 按角色"]
    end

    subgraph MAIN["主进程 · electron/main/"]
        IPC["index.ts<br/>IPC 通道 · 路径白名单校验"]
        WS["workspace.ts<br/>打开 · 恢复 · 持久化 · 导出"]
        ST["store.ts<br/>会话读写 · 原子写"]
    end

    subgraph CORE["共享逻辑 · shared/"]
        PA["parse.ts<br/>多格式只读解析 · SHA-256 指纹"]
        IN["inspect.ts<br/>字段推断 · 对话结构识别"]
        JP["jsonpath.ts<br/>按路径读写字段"]
        PT["patch.ts<br/>补丁构造 · 应用 · 反向"]
        SE["serialize.ts · export.ts<br/>扁平化 · 写导出文件"]
    end

    SRC -->|"只读解析"| PA
    PA --> IN --> WS
    WS --> JP --> PT
    PT --> SE --> OUT
    WS <--> ST <--> SES
    WS <--> IPC
    IPC <-->|"window.corpuseditor"| Z
    Z --> RL
    Z --> RE
    Z --> RP
```

## 测试

| 层级 | 命令 | 覆盖范围 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit -p tsconfig.json` | 全项目 |
| 单元测试 | `npm run test` | 逻辑，node 环境 |
| 冒烟 | `npm run smoke` | 真实主进程 + 替身 Electron |
| GUI | `npm run gui` | 真实 Electron + CDP |

## 许可

[MIT](./LICENSE)
