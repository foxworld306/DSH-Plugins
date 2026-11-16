# scatter / bubble —— 暂停，原因与下一步

状态：**不支持**（类型表里没有，别用）。

## 已经验证过的事实

1. 手写 `<c:scatterChart>` / `<c:bubbleChart>` → 文件能打开，但**图表区是空白**（不报错，静默丢图）。
2. 用 PowerPoint COM 生成参考图（`Temp\chartref\scatter.pptx`）→ 参考文件本身**可以正常打开**，
   说明这台 PowerPoint 支持散点/气泡。
3. 把参考图的 chart1.xml **原封不动**塞进我们的 deck → **可以打开**（连 `<!--SERIES-->` 注释都不介意）。
4. 一旦改写里面的数据缓存（`c:ptCount` / `c:pt`）或公式区间（`c:f`）→ **打不开**，
   即使 ptCount 与区间长度已经对齐。

## 结论

嵌入方式没问题，问题在**改写缓存**这一步。下一步应该：
- 逐字节对比"能打开的版本"和"改过缓存的版本"，找出 PowerPoint 不接受的那个差异；
- 或者干脆不改写：让图表引用真正的 embedded workbook（`c:externalData` + `ppt/embeddings/*.xlsx`），
  由 PowerPoint 自己从工作簿读数据——这条更符合原生做法，但要做 OOXML 里最小的 xlsx 写入。

参考模板留在 `assets/charts/scatter.xml` 与 `bubble.xml`，`refChart()` 也在 `charts.mjs` 里（暂时没接线）。

## 又试了两种写法（都失败）

5. **只改 `<c:numCache>`**（避免误伤 dLbls 的 strCache）→ 仍打不开。
6. **同时修正 `<c:f>` 区间与 ptCount 一致** → 仍打不开。

## 现在的判断

PowerPoint 大概率**不读缓存，读的是 embedded workbook**。缓存只是"打开前先显示"的副本，
而我们既没有嵌入工作簿、又把缓存改得与任何工作簿都对不上，于是整包被拒。

**下一步（唯一没试过的正统做法）**：给图表加 `c:externalData` + `ppt/embeddings/*.xlsx`，
在 xlsx 里写真实数据。需要写一个最小 xlsx（`[Content_Types].xml` / `_rels/.rels` /
`xl/workbook.xml` / `xl/_rels/workbook.xml.rels` / `xl/worksheets/sheet1.xml`），约 100 行。
`refChart()` 与两个模板（scatter.xml / bubble.xml）已就位，接线只差这一步。
