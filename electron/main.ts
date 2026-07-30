import { app, BrowserWindow, dialog, shell } from 'electron'
import { join } from 'path'
import { startServer } from '../src/server/index'

// Single instance lock: prevent multiple windows competing for the port and data.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

// 静态资源（assets/seed 种子数据、landing 落地页、out/renderer 前端构建产物）的根目录。
// - 打包后 process.resourcesPath 指向 asar 同级的 resources 目录，extraResources 把静态
//   资源原样复制到 resources/ 下，可直接用原生 fs 读写，彻底避开 asar 路径兼容问题。
// - 开发时 (electron 直跑 bundle) 不存在 resourcesPath，回退 __dirname 上溯两级。
process.env.APP_ROOT = process.resourcesPath ?? join(__dirname, '..', '..')
// 数据目录：用 Electron 规范的 userData 路径，卸载/备份/多平台都干净。
process.env.ORBIT_DATA_DIR = process.env.ORBIT_DATA_DIR ?? join(app.getPath('userData'), 'data')

let mainWindow: BrowserWindow | null = null

async function createWindow(): Promise<void> {
  // 传 0 让系统分配空闲端口，避开固定端口被占用的冲突。
  const port = await startServer(0)
  const url = `http://localhost:${port}`
  console.log(`[lorekeeper] server ready → ${url}`)
  console.log(`[lorekeeper] APP_ROOT = ${process.env.APP_ROOT}`)
  console.log(`[lorekeeper] ORBIT_DATA_DIR = ${process.env.ORBIT_DATA_DIR}`)

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#111111',
    show: false,
    // 自定义标题栏：隐藏默认 Windows 标题栏，用 web 内容 + 原生窗口按钮覆盖
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#E4D6BD',
      symbolColor: '#3B2F24',
      height: 40,
    },
    // Windows 任务栏和窗口图标。打包后 __dirname 在 app.asar/out/main，图标在 app.asar/build。
    icon: join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      // 页面是我们自己的本地服务器，无需 Node 集成；关掉更安全。
      nodeIntegration: false,
      contextIsolation: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  // 兜底：3 秒后如果 ready-to-show 仍未触发（页面加载出错等），强制显示窗口
  // 这样用户在空白页上能看到 DevTools 或错误信息，不至于无响应。
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      console.warn('[lorekeeper] ready-to-show 未触发，强制显示窗口')
      mainWindow.show()
    }
  }, 3000)

  // 页面里的外部链接（AI 供应商文档等）走系统浏览器，不在应用内开。
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://localhost')) return { action: 'allow' }
    shell.openExternal(target)
    return { action: 'deny' }
  })

  await mainWindow.loadURL(url)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  } else {
    // 窗口已销毁（macOS 上关窗口不退出、或 crash 后残留进程），重新创建
    createWindow().catch((e) => {
      console.error('[lorekeeper] second-instance createWindow failed:', e)
    })
  }
})

app.whenReady().then(async () => {
  try {
    await createWindow()
  } catch (e) {
    const msg = e instanceof Error ? `${e.message}\n\n${e.stack}` : String(e)
    console.error('[lorekeeper] createWindow 失败:', e)
    dialog.showErrorBox('启动失败', msg)
    app.quit()
  }
})
// unhandledRejection / uncaughtException are Node process events, not Electron
// app events - registering them on `app` is a no-op that silently swallows
// fatal async errors. Wire them on process so crashes surface to the user.
process.on('unhandledRejection', (reason) => {
  console.error('[lorekeeper] 未捕获的 Promise 异常:', reason)
  dialog.showErrorBox('启动失败', `发生未捕获异常：\n\n${reason}`)
})
process.on('uncaughtException', (err) => {
  console.error('[lorekeeper] 未捕获的异常:', err)
  dialog.showErrorBox('启动失败', `发生未捕获异常：\n\n${err?.stack ?? err}`)
})

app.on('window-all-closed', () => {
  // Windows/Linux：关掉所有窗口即退出应用（连带结束进程内的服务器）。
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((e) => {
      console.error('[lorekeeper] activate createWindow 失败:', e)
    })
  }
})
