# 评判阶段（文章写完后过一遍，分数不达标回到“成文”）

这一阶段的判据和脚本都在 rankup 与哥飞 Skill 里，这里只规定“什么时候跑、拿什么当通过线”。

1. **哥飞 AI 评分标准**：加载官方 `gefei-page`（见 rankup `references/seo-webcafe.md`）对页面打分；低于其通过线的逐项修。
2. **AITDK 监测**：按 rankup `references/seo-box.md`「AITDK 面板全自动取数」用 `scripts/aitdk-opencli.sh <url>` 跑 SEO、关键词密度、GEO 三类（GEO 判据见 `checklists.md` 闸门 4b、4c）；Issues 与未满分项必修。
3. **ChatGPT 匿名问答**：按 rankup `references/seo-geo.md` 步骤 2–3 的问法、采样与三清单跑，看模型/主题类问题是否会引用或推荐我们的页面；不得用登录态影响结果。
4. **内容质量**：rankup `references/seo-helpful-content.md` 的单页自检表（E-E-A-T、有用内容）。
5. 结果写进该文章的报告：分数、问题、已修项、未修项与原因。生产环境只读检测，不做付费验证。
