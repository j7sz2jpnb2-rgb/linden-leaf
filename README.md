# 🍃 Linden Leaf (菩提叶阅读器)

> 现代化全格式开源电子书阅读器 · 微信读书质感数据看板 · 拟物拟真手绘划线 · 坚果云/WebDAV多端同步

[![GitHub release](https://img.shields.io/badge/release-v1.0.0-purple.svg)](https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE.txt)
[![Electron](https://img.shields.io/badge/Electron-44.0.0-green.svg)](https://www.electronjs.org/)

---

## 🌟 核心特性

- 📖 **全格式极速解析**：原生支持 **EPUB、MOBI、TXT（智能正则分章与去重）、PDF、DOCX、FB2、CBZ** 等多种文档。
- 📊 **微信读书级深度统计看板**：
  - 周 / 月 / 年 / 总历年维度阅读时长与日均分析；
  - 动态峰值高亮与阅读热力图；
  - 「读过/读完/笔记」可点击下钻详情弹窗。
- 🎨 **拟物拟真与多样化主题**：
  - 经典拟物木质书架（iOS 6 iBooks 质感）；
  - 6 款精心调校配色（极简白、羊皮纸、深灰夜间、纯黑 OLED、护眼绿、墨水屏）；
  - 模拟真实手绘笔痕与彩色荧光笔、下划线、虚线划线标注。
- 🪟 **沉浸全屏阅读**：
  - 支持全屏自动隐藏上下栏；
  - 屏幕顶部与底部 50px 边缘悬停智能浮现。
- ☁️ **跨设备 WebDAV / 坚果云云同步**：
  - 自动双向秒级同步阅读进度、书单分类与划线笔记；
  - 严格 CAS ETag 防覆盖与 LWW 冲突解决机制。
- 🖼️ **精美书摘卡片生成器**：
  - 多款国风与极简主题背景；
  - 一键复制高清图片到剪贴板或下载导出。
- 🔄 **GitHub Release 自动版本检测**：
  - 内置更新检测器，一键提醒升级与查看版本日志。

---

## 📥 下载与安装

前往 [Releases 页面](https://github.com/j7sz2jpnb2-rgb/linden-leaf/releases) 下载最新 Windows 安装包或免安装绿色便携版：

- **安装版**：`Linden-Leaf-v1.0.0-Setup.exe`（支持自选安装路径与卸载时数据保留选择）
- **便携版**：`Linden-Leaf-v1.0.0-Portable.exe`（单文件解压即用）

---

## 🛠️ 本地开发与构建

```bash
# 1. 安装依赖
npm install

# 2. 启动开发模式
npm start

# 3. 打包生成 Windows 安装包
npm run dist
```

---

## 📄 开源许可证

本项目基于 [MIT 许可证](LICENSE.txt) 开源。