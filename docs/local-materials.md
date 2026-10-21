# 本地附件与语音

选择文件不会上传；发送时先校验、上传并提取所选范围，成功后提交消息。提取失败时原件保留在本机上传目录，文字仍是浏览器草稿，不创建缺少材料的 AI 任务。刷新后重新选择原文件可续传；也可以明确移除附件。浏览器无法恢复 File 对象，因此只保存文件名称/大小与发送凭据。

每批最多 3 个文件，单文件 1 字节至 2 GiB，4 MiB 分块，总登记容量 10 GiB。每块及最终文件均做 SHA-256 校验；内容相同的原件共用内容寻址对象。原件在数据目录 `uploads/objects`，上传清单在 `uploads/manifests`，派生文本与覆盖范围在 SQLite，原始消息不会被提取内容覆盖。当前不自动清理废弃上传；达到额度后需停服并备份数据，再由后续材料管理功能清理。

支持：

- TXT、Markdown、CSV、JSON、日志、SRT、VTT：最多前 12,000 字符。
- PDF：指定页码，单次最多 20 页；只提取文本层，明确报告实际页范围。扫描 PDF 暂需先转换为图片。
- PNG、JPEG、WebP：中文和英文 OCR；模型只接收 OCR 文本，未查看原图。
- 音视频：指定秒数，最多 600 秒，只转写选定音轨。当前不提取视频帧，也不宣称看过视频。
- 录音：最多 2 分钟，或者选择最多 16 MiB 的语音文件。转写结果可编辑；点击发送后分别保留原始转写和最终文字。音频默认转写后删除，不提供长期保留开关。

模型请求继续受第一阶段 20,000 字符及单任务限额保护；附件提交预留了提示开销，总提取文本与原话最多 18,000 字符。超过范围请缩小页/秒范围，或分批发送。完整原件不会自动发送给模型。

## 依赖

需要 Node 24、ffmpeg/ffprobe、Poppler（pdftotext/pdfinfo）、Tesseract 及 chi_sim/eng 语言包。

可配置：

```
HARNESS_TESSDATA=/path/to/tessdata
HARNESS_SPEECH_PYTHON=/path/to/venv/bin/python
HARNESS_SPEECH_MODEL=/path/to/faster-whisper-small
```

当前云机器已安装 faster-whisper 1.2.1 / CTranslate2 4.8.3，Python 为 `/workspace/.cache/harness/speech-venv/bin/python`；依赖快照位于 `/workspace/.cache/harness/speech-requirements.lock`。OCR 数据在 `/workspace/.cache/harness/tessdata`。`chi_sim.traineddata` 来自 tesseract-ocr/tessdata_fast 官方仓库，SHA-256 为 `a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730`，真实中文图片识别通过。

语音模型应从官方 `Systran/faster-whisper-small` 仓库预先安装到配置目录，包含 model.bin、config.json、tokenizer.json 等完整文件。运行时使用 local_files_only，不下载权重，不调用云转写。当前网络代理拒绝 Hugging Face 模型下载，尚未验证真实中英文转写。已保存官方模型域名的环境配置草稿；草稿不会改变当前运行环境，需要在环境设置保存并发布后生效。

## 验证

`npm test`、`npm run typecheck`、`npm run build`、`npm run test:e2e`。

`npx tsx tests/upload-large.ts` 执行真实 1 GiB 存储验收：256 块，128 块后重建上传实例，继续上传并校验最终摘要。它测试存储层，不等同于浏览器传输 1 GiB。HTTP 分块路径和浏览器发送路径另有小文件集成测试。

后续完整方案仍包括图片缩略图/模型视觉、视频帧与内嵌字幕优先处理、扫描 PDF 页 OCR、可配置语音保留、知识库修订/导出恢复及 MCP。这些能力不会以未实现的状态出现在覆盖范围声明中。
