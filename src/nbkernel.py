# 專案管家的 Jupyter kernel 橋接程式:用 jupyter_client 啟動一個 kernel,
# 從標準輸入收 JSON 指令、把 kernel 的輸出轉成 nbformat 格式,一行一個 JSON 寫到標準輸出。
# 用哪個 Python 執行這支,kernel 就跑在哪個環境(預設的 python3 kernel 用同一個直譯器)。
#
# 指令:{"op":"execute","id":"…","code":"…"} / {"op":"interrupt"} / {"op":"restart"} / {"op":"shutdown"}
# 事件:ready、status、started(執行編號)、output、clear、done、dead、error
import json
import os
import queue
import sys
import threading

lock = threading.Lock()


def emit(obj):
    with lock:
        sys.stdout.write(json.dumps(obj, default=str) + "\n")
        sys.stdout.flush()


try:
    from jupyter_client.manager import KernelManager
except Exception as e:  # 沒裝 jupyter_client / ipykernel
    emit({"ev": "error", "message": f"這個 Python 環境沒有 jupyter_client:{e}"})
    sys.exit(2)

kernel_name = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else "python3"
# Mac/Linux 用本機 IPC(不開 TCP 埠);Windows 只能用 TCP(只綁 127.0.0.1)
km = KernelManager(kernel_name=kernel_name, transport="tcp" if os.name == "nt" else "ipc")
if os.name != "nt":
    # IPC 連線檔放系統暫存資料夾,不要留在使用者的專案裡
    import tempfile
    km.ip = os.path.join(tempfile.gettempdir(), f"steward-kernel-{os.getpid()}")
try:
    km.start_kernel(cwd=os.getcwd())
    kc = km.client()
    kc.start_channels()
    kc.wait_for_ready(timeout=90)
except Exception as e:
    emit({"ev": "error", "message": f"kernel 啟動失敗:{e}"})
    try:
        km.shutdown_kernel(now=True)
    except Exception:
        pass
    sys.exit(3)

pending = {}  # kernel 的 msg_id -> 網頁的 id
emit({"ev": "ready", "kernel": kernel_name, "python": sys.executable})


def iopub():
    while True:
        try:
            msg = kc.get_iopub_msg(timeout=1)
        except queue.Empty:
            continue
        except Exception:
            return
        rid = pending.get(msg.get("parent_header", {}).get("msg_id"))
        t, c = msg["msg_type"], msg["content"]
        if t == "status":
            emit({"ev": "status", "state": c.get("execution_state"), "id": rid})
            if rid and c.get("execution_state") == "idle":
                emit({"ev": "done", "id": rid})
        elif t == "execute_input":
            emit({"ev": "started", "id": rid, "execution_count": c.get("execution_count")})
        elif t == "stream":
            emit({"ev": "output", "id": rid, "output": {"output_type": "stream", "name": c.get("name"), "text": c.get("text", "")}})
        elif t in ("display_data", "update_display_data"):
            emit({"ev": "output", "id": rid, "output": {"output_type": "display_data", "data": c.get("data", {}), "metadata": c.get("metadata", {})}})
        elif t == "execute_result":
            emit({"ev": "output", "id": rid, "output": {"output_type": "execute_result", "execution_count": c.get("execution_count"), "data": c.get("data", {}), "metadata": c.get("metadata", {})}})
        elif t == "error":
            emit({"ev": "output", "id": rid, "output": {"output_type": "error", "ename": c.get("ename"), "evalue": c.get("evalue"), "traceback": c.get("traceback", [])}})
        elif t == "clear_output":
            emit({"ev": "clear", "id": rid, "wait": bool(c.get("wait"))})


def watchdog():
    import time
    while True:
        time.sleep(2)
        try:
            if not km.is_alive():
                emit({"ev": "dead"})
                return
        except Exception:
            return


threading.Thread(target=iopub, daemon=True).start()
threading.Thread(target=watchdog, daemon=True).start()

for line in sys.stdin:
    try:
        cmd = json.loads(line)
    except Exception:
        continue
    op = cmd.get("op")
    try:
        if op == "execute":
            mid = kc.execute(cmd.get("code", ""), allow_stdin=False, store_history=True)
            pending[mid] = cmd.get("id")
        elif op == "interrupt":
            km.interrupt_kernel()
        elif op == "restart":
            km.restart_kernel(now=True)
            pending.clear()
            kc.wait_for_ready(timeout=90)
            emit({"ev": "ready", "kernel": kernel_name, "python": sys.executable, "restarted": True})
        elif op == "shutdown":
            break
    except Exception as e:
        emit({"ev": "error", "message": str(e), "id": cmd.get("id")})

try:
    kc.stop_channels()
    km.shutdown_kernel(now=True)
except Exception:
    pass
