console.log("[*] Started to fix, let's rock!")

const STARTS = ['iz']
const KEYWORDS = []

function isTargetPlugin(address) {
    if (!address) return false

    const module = Process.findModuleByAddress(address)
    if (!module) return false

    const name = module.name.toLowerCase()
    const matched = STARTS.some(k => name.startsWith(k)) || KEYWORDS.some(k => name.includes(k))

    if (matched) return true

    return false
}

// === Target(HWND) -> Datum(w, h, scale) 数据结构 ===
const windowDatumMap = new Map()

// 提前声明需要用到的 Win32 API
const user32 = Process.findModuleByName("user32.dll")
const opengl32 = Process.findModuleByName("opengl32.dll")

// 获取 GetDpiForWindow (Win10 1607+)
const pGetDpiForWindow = user32 ? user32.findExportByName("GetDpiForWindow") : null
let GetDpiForWindow = null
if (pGetDpiForWindow) GetDpiForWindow = new NativeFunction(pGetDpiForWindow, 'uint', ['pointer'])
else throw("No GetDpiForWindow, can't fix for you!!")


// 用于在 glViewport 中逆向获取当前属于哪个窗口 (HDC -> HWND)
const wglGetCurrentDC = new NativeFunction(opengl32.findExportByName("wglGetCurrentDC"), 'pointer', [])
const WindowFromDC = new NativeFunction(user32.findExportByName("WindowFromDC"), 'pointer', ['pointer'])

// 1. 获取窗口真实物理宽高及 DPI 缩放因子
const getClientRect = user32 ? user32.findExportByName("GetClientRect") : null
if (getClientRect) Interceptor.attach(getClientRect, {
    onEnter(args) {
        this.hwnd = args[0] // 记录目标句柄 (Target)
        this.rectPtr = args[1]
    },
    onLeave(retval) {
        if (isTargetPlugin(this.returnAddress) && retval.toInt32() !== 0) {
            // RECT 结构体：left(0), top(4), right(8), bottom(12)
            const realW = this.rectPtr.add(8).readInt() - this.rectPtr.readInt()
            const realH = this.rectPtr.add(12).readInt() - this.rectPtr.add(4).readInt()

            // 获取当前窗口的 DPI 并计算缩放因子 (DPI / 96)；虽说这个也能靠Hook，因为它也会被调用
            let scaleFactor = 1.0
            if (GetDpiForWindow) {
                const dpi = GetDpiForWindow(this.hwnd)
                scaleFactor = dpi / 96.0
            }

            // 将数据绑定到对应的 HWND (Target)
            const targetKey = this.hwnd.toString()
            windowDatumMap.set(targetKey, { w: realW, h: realH, scale: scaleFactor })

            // console.log(`[GetClientRect] Target: ${targetKey} | 尺寸: ${realW}x${realH} | 缩放因子: ${scaleFactor.toFixed(2)}`)
        }
    }
})

// 2. 爆改 glViewport (物理渲染区域)
const glViewport = opengl32 ? opengl32.findExportByName("glViewport") : null
if (glViewport) Interceptor.attach(glViewport, {
    onEnter(args) {
        if (!isTargetPlugin(this.returnAddress)) return

        // 提取当前 OpenGL 正在渲染的目标窗口 (Target)
        const currentHDC = wglGetCurrentDC()
        if (currentHDC.isNull()) return

        const currentHWND = WindowFromDC(currentHDC)
        if (currentHWND.isNull()) return

        const targetKey = currentHWND.toString()

        // 按照 Target 提取对应的 Datum 数据
        const datum = windowDatumMap.get(targetKey)
        if (!datum) return

        // 动态应用缩放因子代替写死的 1.5
        const targetW = Math.floor(datum.w * datum.scale)
        const targetH = Math.floor(datum.h * datum.scale)

        args[2] = ptr(targetW)
        args[3] = ptr(targetH)

        // console.log(`[glViewport] Target: ${targetKey} | 动态大改：${targetW}x${targetH} (x${datum.scale.toFixed(2)})`)
    }
})