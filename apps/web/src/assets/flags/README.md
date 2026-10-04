# 国旗静态资源来源

- 来源：Twemoji **14.0.2**，Twitter, Inc and other contributors，Copyright 2019。
- 上游：https://github.com/twitter/twemoji/tree/v14.0.2/assets/svg
- 原始归档：https://codeload.github.com/twitter/twemoji/tar.gz/refs/tags/v14.0.2
- 归档 SHA-256：`27dc3087fd067d321aff3e859056773aca748510b18b8b058276f6fa57e7f16c`。
- 图形许可证：**CC-BY 4.0**，https://creativecommons.org/licenses/by/4.0/ ，完整文本见 `LICENSE-GRAPHICS`。
- 仅提取文件名为两个 `U+1F1E6`～`U+1F1FF` 区域指示符的 258 个原始 SVG；未修改图形，不包含 Twemoji 脚本或其他表情。
- 构建通过 Vite 导入同源资源 URL，禁止 SVG 内联进 JS，不使用第三方 CDN。页面只请求显示的旗帜。
- 分发署名与完整许可位于前端公开目录 `/third-party/twemoji.txt`、`/third-party/twemoji-LICENSE-GRAPHICS.txt`。

更新时从固定版本重新提取该白名单子集，核对来源版本、归档摘要、数量、完整许可及安全测试，不在运行时下载资源。
