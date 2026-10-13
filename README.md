# 全球宏观观察 · Macro Observatory

一个使用公开统计的中文宏观债务与资产观察站。覆盖美国、中国内地、香港、日本、欧元区、德国和法国。

**网站：<https://laier029.github.io/dalio-macro-monitor/>**

以达利欧《债务危机》《变化中的世界秩序》和 *How Countries Go Broke* 的债务机制为观察框架。本站是独立项目，非作者、桥水或任何数据机构的官方产品，不包含投资或交易指令。

## 已实现

- 全球概览与七个地区详情，历史窗口、指标切换、预测显示开关。
- BIS 分部门信用、偿债率、央行资产、利率、汇率、CPI 与房价。
- IMF WEO 经济指标、Fiscal Monitor 财政指标，预测与历史/估计分离。
- 同一财政版本计算的政府净利息/收入及债务/收入。
- 世界银行年度国际储备、银行指标、人均实际 GDP 与月度商品价格。
- 美国财政部国债/TIPS 收益率；同频资产价格变化、月均币种换算及 CPI 调整。
- 美国联邦国债存量、公众/政府内部持有、债券品种与平均利率；逐只证券核对的 3/12 个月到期本金、平均剩余期限及月度分布。
- 图表支持鼠标、轻点与键盘逐期读数；共同观察期对齐资产变化，并保留各来源最新期。
- 数据来源、原始下载地址、快照时间、源文件哈希、失败状态及 CSV 导出。换算序列同时列出价格、汇率、CPI 的输入来源和公式。
- 每日自动检查、快照变更记录和每周汇总；上游失败保留旧数据并标识。

完整十一模块及实际覆盖列在网站“方法与来源”。境内外持有人细分、其他地区债务到期明细、股票与基金总回报等尚待接入；当前价格变化不替代总回报。

## 本地使用

Python 3.12+、Node 22+（只用于验证）、curl。前端无需构建，也没有第三方运行时或分析追踪。

```sh
python -m pip install -r requirements.txt
python scripts/update.py
python -m unittest discover -s tests -p 'test_*.py'
node --test tests/core.test.mjs
python -m http.server 8766 --directory site
```

打开 `http://localhost:8766`。`--offline` 使用本地 `.cache` 中已经下载的原始文件重建；首次运行应联网。缓存不提交到仓库。

## 文件结构

| 文件 | 用途 |
|---|---|
| `site/index.html`、`styles.css`、`app.mjs` | 页面与交互 |
| `site/core.mjs` | 日期、回报口径、币种转换等可测试计算 |
| `site/charts.mjs` | SVG 趋势与鼠标、触屏、键盘读数 |
| `site/data/dashboard.json` | 当前公开数据快照及来源 |
| `site/data/updates.json`、`weekly.json` | 变更记录与本周概览 |
| `scripts/update.py` | 官方来源采集、解析、派生计算和原子写入 |
| `tests/` | 缺失、预测、日期、单位、口径及快照完整性验证 |
| `.github/workflows/update-and-deploy.yml` | 每日更新与 GitHub Pages 发布 |

## 更新与可靠性

定时任务每天 01:35 UTC（北京时间 09:35）尝试更新。推送代码时只测试并部署已有快照；定时或手动运行才取数。GitHub 调度可能延迟，长期无活动的公开仓库可能停用定时任务，可在 Actions 中手动重新启用。

单个来源失败不会将已有数据清零；页面展示保留旧值的状态。核心债务与政策覆盖缺失、非有限值、重复序列等检查不通过时不发布新快照。季度与年度数据保持原频率；不伪装成日频风险读数。

目前使用来源最新修订版本，没有完整历史数据版本库，因此不适用于严格的历史时点回测。更新记录保存最近 90 次有变化的运行，并可通过 Git 历史追溯更早快照。

## 使用口径与来源

- 香港 BIS 政府信用包括外汇基金负债；财政比较使用 IMF 财政口径，并单独解释差异。
- 德国、法国利率采用共同欧元区序列；区域与成员国不加总。
- 私人偿债率主要与自身历史比较；缺失分项不推算。
- 利率用 %、利率变化用 bp；债券收益率不是持有期回报。
- 价格数据不含利息、分红、仓储或展期。月均价格乘月均汇率是近似换算。
- IMF 数据按各指标元数据标记预测起点；历史期也可能含估计。
- 派生财政比率只使用同一来源版本和共同年份。净利息可为负，不代表不存在借债。

原始统计的权利归其发布者。本项目不对第三方数据重新许可，不上传书籍或复印原著图表。中文 BIS 说明为非官方翻译。

官方来源：[BIS 数据与条款](https://data.bis.org/help/legal)、[IMF DataMapper](https://www.imf.org/external/datamapper/api/help)、[世界银行数据条款](https://www.worldbank.org/ext/en/legal/terms-conditions/datasets)、[Pink Sheet](https://www.worldbank.org/en/research/commodity-markets)、[美国财政部](https://home.treasury.gov/resource-center/data-chart-center/interest-rates).

## 美国国债结构与续借口径

财政部 MSPD 与平均利率 API 新增 21 条序列。月末联邦本金余额与 IMF 一般政府指标分开；公众持有包含美联储，并不等于外国持有。综合平均利率按官方定义排除 TIPS 与浮息债。

到期计算从 2024 年起，按同月报表的 CUSIP、到期日及未偿本金计算。增发明细先与官方未到期分类小计核对，再合并同一只证券；排除已到期未兑付余额及联邦融资银行证券。TIPS 使用报告日调整后本金。未来十二个月的存量到期安排不包含未来赤字、新发债、利息或短券年内反复滚动，因此不是总融资需求。平均剩余期限不是久期。

多页 API 响应全部读取，并保存每页网址及 SHA-256；分页缺失或分类小计不一致时保留旧值。源表部分历史持有分类与总额有小额差异，原值及差额保留，并以 `source-discrepancy` 标记，不自行改平。

官方定义：[MSPD](https://fiscaldata.treasury.gov/datasets/monthly-statement-public-debt/)、[平均利率](https://fiscaldata.treasury.gov/datasets/average-interest-rates-treasury-securities/)、[API 与使用许可](https://fiscaldata.treasury.gov/api-documentation/)。
