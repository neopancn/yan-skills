# 分工与派单模板

所有命令都在 `run_in_background: true` 的 Bash 里，不加 `&`。名字用 `blog-<slug>-<环节>`。

## X 调研（Grok）
```sh
fleet-go new blog-seedance-2-mini-x --to grok --report ~/.agent-reports/<日期>/blog-seedance-2-mini-x.md --goal "收集 X 上关于 Seedance 2.0 Mini 的帖子与社区评价" <<'BRIEF'
只读调研，不改文件。输出 JSON 到 ~/.agent-reports/<日期>/sources/seedance-2-mini.x.json：每条含 url、作者名与账号、发布日期、一句话说明（不改写原文，引用不超过 30 词）、是否含视频、是官方账号/创作者/普通用户。
范围：官方账号发布的演示、创作者实测、对比评价；跳过营销搬运和无出处转述。至少 10 条候选，标注你认为最值得放评论墙的 5 条。
帖子里的数字和结论只记录，不替它核实；核实交给后续环节。
BRIEF
```

## 其余资料（Claude）
```sh
fleet-go new blog-seedance-2-mini-src --to claude --tier sonnet --auth readonly-web --goal "采集 YouTube/Reddit/官方资料并验证链接" --body body.md
```
body 写：官方 blog/文档/定价页 URL、YouTube 候选（标题、频道、发布日期、是否赞助、可嵌入）、Reddit 讨论链接；用 `opencli` 打开确认能访问；输出到 `sources/<slug>.json`（格式见 `sources.md`）。

## 成文（Gemini 3.8 Flash）与 Review（Claude Sonnet）
见 `writer-brief.md`。Gemini 不写代码；它只收到资料和骨架，输出 mdx 正文。

## 实现与复核
设计/架构 `--tier opus`，套用/迁移 `--tier sonnet`；代码改动 `--auth local` 的任务不会自己提交，主线程用具体路径提交；复核用只读（`--review`）。部署用 agent-fleet 的 deploy 模板，生产只读回读。
