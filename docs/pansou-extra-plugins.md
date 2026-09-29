# 上游 PanSou 的本地改动说明

`app/pansou.exe` 不是上游原样编译的产物，改动**只有一处**：`main.go` 的插件 import 列表。

上游 `main.go` 只对 77 个插件包做了 `_ "pansou/plugin/xxx"` 匿名导入，
但 `plugin/` 目录下另有 34 个插件包已经写好（自带 `init()` 和 `RegisterGlobalPlugin` 调用），
只是没被 import，运行时根本不会注册。补上这 34 行后，运行时注册的插件从 **74 个增加到 108 个**。

## 补上的 34 行

```go
	_ "pansou/plugin/ahhhhfs"
	_ "pansou/plugin/aikanzy"
	_ "pansou/plugin/alupan"
	_ "pansou/plugin/ash"
	_ "pansou/plugin/bixin"
	_ "pansou/plugin/daishudj"
	_ "pansou/plugin/discourse"
	_ "pansou/plugin/haisou"
	_ "pansou/plugin/hdr4k"
	_ "pansou/plugin/javdb"
	_ "pansou/plugin/jikepan"
	_ "pansou/plugin/kkmao"
	_ "pansou/plugin/leijing"
	_ "pansou/plugin/miaoso"
	_ "pansou/plugin/mikuclub"
	_ "pansou/plugin/mizixing"
	_ "pansou/plugin/pan666"
	_ "pansou/plugin/panta"
	_ "pansou/plugin/panwiki"
	_ "pansou/plugin/panyq"
	_ "pansou/plugin/panzun"
	_ "pansou/plugin/pianku"
	_ "pansou/plugin/qingying"
	_ "pansou/plugin/qupansou"
	_ "pansou/plugin/sdso"
	_ "pansou/plugin/wuji"
	_ "pansou/plugin/xdyh"
	_ "pansou/plugin/xiaoji"
	_ "pansou/plugin/xinjuc"
	_ "pansou/plugin/xuexizhinan"
	_ "pansou/plugin/xys"
	_ "pansou/plugin/yiove"
	_ "pansou/plugin/ypfxw"
	_ "pansou/plugin/yuhuage"
```

## 复现方式

```bash
git clone --depth 1 https://github.com/fish2018/pansou.git
cd pansou
# 把上面 34 行追加到 main.go 的 import 块末尾
go build -o pansou.exe .
```

## 实测

- 插件数：74 个（旧）→ 108 个（新）
- 无代理直连模式搜「庆余年」：198 条夸克结果（旧）→ 217 条（新）
- 108 个插件里 79 个的站点实测国内可直连
- 确实需要代理的只有 7 个：`cyg` `duoduo` `qqpd` `weibo` `duanjuw` `miosou` `zhizhen`
- 以上数字可用仓库里的未接线插件目录对照复算

## 许可

上游为 MIT 许可（见其仓库 LICENSE）。此处仅补充 import 行，未改动任何业务代码。