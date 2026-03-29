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

const windowDatumMap = new Map()

const user32 = Process.findModuleByName("user32.dll")
const opengl32 = Process.findModuleByName("opengl32.dll")

const pGetDpiForWindow = user32 ? user32.findExportByName("GetDpiForWindow") : null
let GetDpiForWindow = null
if (pGetDpiForWindow) GetDpiForWindow = new NativeFunction(pGetDpiForWindow, 'uint', ['pointer'])
else throw("No GetDpiForWindow, can't fix for you!!")

const wglGetCurrentDC = new NativeFunction(opengl32.findExportByName("wglGetCurrentDC"), 'pointer', [])
const WindowFromDC = new NativeFunction(user32.findExportByName("WindowFromDC"), 'pointer', ['pointer'])

const getClientRect = user32 ? user32.findExportByName("GetClientRect") : null
if (getClientRect) Interceptor.attach(getClientRect, {
    onEnter(args) {
        this.hwnd = args[0]
        this.rectPtr = args[1]
    },
    onLeave(retval) {
        if (isTargetPlugin(this.returnAddress) && retval.toInt32() !== 0) {
            const realW = this.rectPtr.add(8).readInt() - this.rectPtr.readInt()
            const realH = this.rectPtr.add(12).readInt() - this.rectPtr.add(4).readInt()

            let scaleFactor = 1.0
            if (GetDpiForWindow) {
                const dpi = GetDpiForWindow(this.hwnd)
                scaleFactor = dpi / 96.0
            }

            const targetKey = this.hwnd.toString()
            windowDatumMap.set(targetKey, { w: realW, h: realH, scale: scaleFactor })

            // console.log(`[GetClientRect] Target: ${targetKey} | 尺寸: ${realW}x${realH} | 缩放因子: ${scaleFactor.toFixed(2)}`)
        }
    }
})

const glViewport = opengl32 ? opengl32.findExportByName("glViewport") : null
if (glViewport) Interceptor.attach(glViewport, {
    onEnter(args) {
        if (!isTargetPlugin(this.returnAddress)) return

        const currentHDC = wglGetCurrentDC()
        if (currentHDC.isNull()) return

        const currentHWND = WindowFromDC(currentHDC)
        if (currentHWND.isNull()) return

        const targetKey = currentHWND.toString()

        const datum = windowDatumMap.get(targetKey)
        if (!datum) return

        const targetW = Math.floor(datum.w * datum.scale)
        const targetH = Math.floor(datum.h * datum.scale)

        args[2] = ptr(targetW)
        args[3] = ptr(targetH)

        // console.log(`[glViewport] Target: ${targetKey} | 动态大改：${targetW}x${targetH} (x${datum.scale.toFixed(2)})`)
    }
})
