@echo off
rem ===== editable settings =====
rem ===== proxy auto-detect =====
rem Telegram channels need a proxy, but pointing PanSou at a proxy that is NOT
rem running makes EVERY source fail (China-direct sites included). Probe first,
rem fall back to a direct connection. To force a port, put just the number in
rem proxy-port.txt next to this file.
set "PROXY="
if exist "%~dp0proxy-port.txt" (
  for /f "usebackq tokens=1" %%a in ("%~dp0proxy-port.txt") do if not "%%a"=="" set "PROXY=socks5://127.0.0.1:%%a"
)
if not defined PROXY call :detect_proxy 7897
if not defined PROXY call :detect_proxy 7890
if not defined PROXY call :detect_proxy 7891
if not defined PROXY call :detect_proxy 7892
if not defined PROXY call :detect_proxy 1080
if not defined PROXY call :detect_proxy 10808
if not defined PROXY call :detect_proxy 10809
if not defined PROXY call :detect_proxy 2080
goto :proxy_ready
:detect_proxy
netstat -ano -p tcp 2>nul | findstr /c:"127.0.0.1:%1 " | findstr /i /c:"LISTENING" >nul 2>&1
if not errorlevel 1 set "PROXY=socks5://127.0.0.1:%1"
goto :eof
:proxy_ready
if defined PROXY (echo [config] proxy found: %PROXY%) else (echo [config] no local proxy found - using direct connection)
rem PanSou API port and web UI port
set PORT=8888
set UIPORT=8899
rem cache and async search tuning
set CACHE_ENABLED=true
set CACHE_PATH=%~dp0app\cache
set CACHE_MAX_SIZE=200
set CACHE_TTL=120
set ASYNC_PLUGIN_ENABLED=true
set ASYNC_RESPONSE_TIMEOUT=15
set ASYNC_MAX_BACKGROUND_WORKERS=80
set ASYNC_MAX_BACKGROUND_TASKS=400
set TG_CHANNEL_REQUEST_TIMEOUT_SECONDS=10
rem ===== Telegram channels =====
set CHANNELS=tgsearchers7,Aliyun_4K_Movies,yunpanx,yp123pan,yunpanxunlei,tianyifc,peccxinpd,gotopan,PanjClub,baicaoZY,MCPH02,MCPH03,bdwpzhpd,Q66Share,ucwpzy,shareAliyun,Quark_Movies,XiangxiuNBB,ucquark,xx123pan,yingshifenxiang123,zyfb123,Lsp115,taoxgzy,Channel_Shares_115,vip115hot,wp123zy,yunpan139,yunpan189,yunpanuc,yydf_hzl,leoziyuan,yoyokuakeduanju,TG654TG,QukanMovie,yeqingjie_GJG666,movielover8888_film3,Baidu_netdisk,D_wusun,FLMdongtianfudi,KaiPanshare,rjyxfx,PikPak_Share_Channel,newproductsourcing,QuarkFree,yunpanNB,kkdj001,xxzlzn,pxyunpanxunlei,jxwpzy,kuakedongman,xiangnikanj,solidsexydoll,guoman4K,zdqxm,kduanju,cilidianying,CBduanju,SharePanFilms,dzsgx,BooksRealm,douerpan,Netdisk_Movies,yunpanquark,ciliziyuanku,jzmm_123pan,wpan8,mqte5,regengguangya,regeng115,regeng123,yy80986098,pan_guangya,guangyapan_episode,guangya_hdhive,guangyapindao,quark_res,domgmingapk,dianying4k,tgbokee,ucshare,gokuapan,WFYSFX03,gimy100,gimy115iso,fcij5,xvth5,xuexiziliaobaibaoku,phzvip,jdbigdiscount,youxigs,zhoulanziyuan,seedhub_pro,jnjy_5,xxziliao,wpzyk,ruanjianfenxiang77,jpnd5,XunLeiPinDao,a123fxme,WPpindao,kuyupan,djya5,zh_vip,gdsharing,guangyaya2026,alyp_17362,baidyunpan,yunpans,rbzhwpzy,Panzi88com,bdbdndn11,bsbdbfjfjff,BaiduCloudDisk,txtyzy,MCPH01,ysxb48,jdjdn1111,MCPH086,zaihuayun,Oscar_4Kmovies,alyp_1,dianyingshare,ydypzyfx,tyypzhpd,tianyirigeng,hdhhd21,oneonefivewpfx,tyysypzypd,pikpakpan,Q_dongman
rem ===== search plugins =====
set ENABLED_PLUGINS=5266ys,ahhhhfs,aikanzy,aipan,alupan,ash,bixin,btbtlb,buerchen,cldi,clmao,clxiong,cyg,daishudj,diduan,discourse,djgou,duanjuw,duoduo,dy4k,dygang,dyyj,dyyjpro,erxiao,erxiaopan,feikuai,gaoqing888,gying,haisou,haitunsou,hdmoli,hdr4k,hjzhencai,huban,hunhepan,ikantv,javdb,jikepan,jsnoteclub,jupansou,jutoushe,kkmao,kkv,kpkuang,labi,leijing,leso,libvio,lingjisp,lou1,meitizy,melost,miaoso,mikuclub,miosou,mizixing,muou,nsgame,nyaa,ouge,pan365,pan666,panlian,pansearch,panta,panwiki,panyq,panzun,pianku,qingying,qiwei,qqpd,quark4k,quarkres,quarksoo,quarktv,qupanshe,qupansou,rrbt,sdso,shandian,sopanya,sousou,susu,thepiratebay,ting77,u3c3,wanou,weibo,woniu,wuji,xb6v,xdpan,xdyh,xiaoji,xiaokupan,xiaoyu,xiaozhang,xinjuc,xuexizhinan,xys,yingso,yiove,ypfxw,yuhuage,yulinshufa,yunso,yunsou,zhizhen,zlxapp,zxzj
