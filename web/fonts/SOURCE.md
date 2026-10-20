# Noto Sans SC 网页字体来源与许可

本地 Demo 与香港测试站统一自托管 `NotoSansSC-VF.woff2`，无需访问第三方字体 CDN 或在用户设备安装字体。网页主字体为 Noto Sans SC，未覆盖字符由浏览器通用 sans-serif 回退；没有声明苹方、微软雅黑或其他专有字体。

## 上游与许可

取得日期：2026-10-17。官方来源为 [Google Fonts 的 Noto Sans SC](https://github.com/google/fonts/tree/47d54ca1ebb14fd864695f1d39dc734f39017c33/ofl/notosanssc)，固定提交 `47d54ca1ebb14fd864695f1d39dc734f39017c33`。

- 原始文件：[NotoSansSC[wght].ttf](https://raw.githubusercontent.com/google/fonts/47d54ca1ebb14fd864695f1d39dc734f39017c33/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf)。
- 许可：[SIL Open Font License 1.1](OFL.txt)，版权声明为 Copyright 2014-2021 Adobe，Reserved Font Name 为 `Source`。本字库仍使用 Noto Sans SC 名称，没有以保留名称发布派生版本。
- OFL 允许网站嵌入、随软件分发及修改字体；分发字体须保留版权和完整许可，不单独售卖字体，不改用其他字体许可，也不以作者名义作背书。详见原文及 [OFL 官方说明](https://openfontlicense.org/)。字体许可不要求网站代码整体采用 OFL。

许可证、来源说明与 WOFF2 一起进入部署包，并可通过 `/fonts/OFL.txt`、`/fonts/SOURCE.md` 查看；不能只发布字库而漏掉许可。

## 网页文件与校验

将官方 TTF 使用 FontTools 转为 WOFF2 压缩格式；没有删减字符或修改字形，保留字体内部版权和许可信息。字重轴为 100–900，覆盖页面使用的普通、粗体和中间字重。WOFF2 为 7,782,088 字节，浏览器可缓存一天；更新字库时同步修改 CSS 与预加载链接的版本参数。

| 文件 | SHA-256 |
| --- | --- |
| 原始 TTF | `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da` |
| NotoSansSC-VF.woff2 | `7fabc1ef45ba1bd4d8dea904f51f408cfb515cf56c5ad813836df34c01171159` |
| OFL.txt | `1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9` |

已核对转换前后 30,890 个 Unicode 字符映射一致，并检查档案中全部股票名称使用的 1,434 种字符，没有缺字。详细记录见仓库 `research/font_download_validation.json`。仅重建字库需要 FontTools 和 Brotli，网站运行不依赖它们：

```python
from fontTools.ttLib import TTFont
font = TTFont("NotoSansSC[wght].ttf")
font.flavor = "woff2"
font.save("NotoSansSC-VF.woff2")
```

旧苹方文件与原来源说明已移至本机忽略目录 `data/legacy-fonts-20261017/` 保留，不再属于当前网页资源或部署包。没有改写 Git 历史，历史提交仍可能包含旧字库。
