# 第三方组件

本仓库自身代码采用 MIT 许可（见 LICENSE）。运行 / 打包时还会用到以下第三方组件，版权归各自作者所有：

## PanSou
- 项目：https://github.com/fish2018/pansou
- 用途：网盘资源搜索 API（TG 频道 + 插件聚合）
- 许可：见原项目仓库
- 说明：`app/pansou.exe` 是**在上游基础上修改后自行编译**的产物。改动只有一处：
  上游 `main.go` 的 plugin import 列表只接入了 77 个插件包，而仓库里另有 34 个插件
  已经写好（`plugin/haisou`、`plugin/pan666`、`plugin/panwiki`、`plugin/mizixing` 等）却没有接线，
  这里把它们补进 import 列表，运行时注册的插件从 74 个增加到 108 个。上游业务代码未做其他改动。
  本仓库不包含上游源码，使用与再分发请遵守原项目许可。

## Node.js
- 项目：https://nodejs.org
- 许可：MIT
- 说明：便携包内 `runtime/node.exe` 为官方发行版原文件。

## 影视元数据接口
- Bangumi（https://bgm.tv）公开 API
- 豆瓣（https://douban.com）公开接口

封面图片均经本机代理直连原站，不做二次存储或转售。
