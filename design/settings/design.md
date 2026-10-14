# Final Model 单页设置设计

本次只设计 /Users/eachann/Work/pi-final-model 的设置页；不引入其他项目的输入增强、输出折叠、状态栏或外观配置。

- 设置区：保留 enabled 开关、model 搜索与单选；关闭功能仍允许预先选择模型。
- 预览区：工作模型只读显示，执行与最终整理缩成一行；工作模型不会被切换。
- 状态区：保存反馈、任务状态、重试与恢复按情境出现，不增加持久化设置。原型仅演示浏览器保存失败/重试；真实任务状态与恢复尚未接入。
- 视觉：图 2 的粉色、青蓝、紫色颗粒云雾向下淡到白色，保留直角、黑白文字、细边框与轻微硬阴影；去掉图 1 的整块粉色、半屏宣传区。
- 原型：仅读写独立 localStorage 的 pi-final-model-settings-design-v1，模型目录和 smart 工作模型为示例，不读取或写入真实 Pi 配置；首屏启用为设计演示值，插件真实新安装默认关闭。
- 交付：index.html 为可编辑源稿，final-model.html 为内嵌全部图像与图标的单文件 HTML；设计稿由浏览器实际渲染截图。
- 重建：在项目根目录运行 `python3 design/settings/build.py`。
- 资产：背景由内置 ImageGen 按图 2 生成，Tabler Icons outline 使用 MIT，品牌图标复用项目现有资产。
