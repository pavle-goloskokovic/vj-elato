"""Hard limits for automated browser runs (Windows).

A tool timeout does not stop a browser: the command only moves to the background and the
browser keeps running. So every run here carries its own deadline and memory ceiling, and
refuses to start while a build is running somewhere on the machine. Playwright's Chrome is
recognised by its temporary profile folder in the command line.

    from watchdog import Watchdog, builds_running
    if builds_running(): sys.exit("a build is running; try again later")
    with Watchdog(deadline_s=1500, max_mb=1500):
        ...
"""
import subprocess, sys, threading, time

PS = ["powershell", "-NoProfile", "-NonInteractive", "-Command"]
MARK = "playwright"          # part of the profile path Playwright gives its browsers

def _ps(cmd):
    try: return subprocess.run(PS + [cmd], capture_output=True, text=True, timeout=25).stdout
    except Exception: return ""

def browser_processes():
    """[(pid, private MB, kind)] of Playwright-launched Chrome processes. Private bytes, not the
    working set: the working set counts shared DLL pages once per process and overstates a
    multi-process browser by hundreds of MB."""
    out = _ps(f"Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='chrome-headless-shell.exe'\" | Where-Object {{ $_.CommandLine -like '*{MARK}*' }} | ForEach-Object {{ $k = if ($_.CommandLine -match '--type=([a-z-]+)') {{ $Matches[1] }} else {{ 'browser' }}; '{{0}} {{1}} {{2}}' -f $_.ProcessId, $_.PrivatePageCount, $k }}")
    procs = []
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 3 and parts[0].isdigit(): procs.append((int(parts[0]), int(parts[1]) / 1e6, parts[2]))
    return procs

def describe(procs):
    by_kind = {}
    for _, mb, kind in procs: by_kind[kind] = by_kind.get(kind, 0) + mb
    return ", ".join(f"{k} {v:.0f} MB" for k, v in sorted(by_kind.items(), key=lambda x: -x[1]))

def kill_browsers(reason):
    procs = browser_processes()
    print(f"\n  WATCHDOG: {reason}; browser was: {describe(procs)}", file=sys.stderr, flush=True)
    for pid, _, _ in procs:
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
    print(f"  WATCHDOG: killed {len(procs)} browser process(es)", file=sys.stderr, flush=True)

def builds_running():
    """True when something that looks like a build or install is running anywhere."""
    out = _ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='tsc.exe' or Name='esbuild.exe' or Name='npm.cmd'\" | ForEach-Object { $_.CommandLine }")
    for line in out.splitlines():
        l = line.lower()
        if any(k in l for k in ("npm install", "npm ci", "npm run build", "tsc", "esbuild", "webpack", "vite build", "rollup", "next build")): return True
    return False

class Watchdog:
    def __init__(self, deadline_s=1500, max_mb=1500, interval_s=10, trace=False):
        self.deadline_s, self.max_mb, self.interval_s, self.trace = deadline_s, max_mb, interval_s, trace
        self.fired = None; self._stop = threading.Event(); self.peak = 0
    def __enter__(self):
        self.t0 = time.time()
        self.thread = threading.Thread(target=self._run, daemon=True); self.thread.start()
        return self
    def __exit__(self, *a):
        self._stop.set()
        left = browser_processes()
        if left: kill_browsers("browser still running after the test")
    def _run(self):
        while not self._stop.wait(self.interval_s):
            if time.time() - self.t0 > self.deadline_s:
                self.fired = "deadline"; kill_browsers(f"deadline of {self.deadline_s}s reached"); return
            procs = browser_processes()
            total = sum(mb for _, mb, _ in procs)
            self.peak = max(self.peak, total)
            if self.trace: print(f"  mem {total:.0f} MB: {describe(procs)}", file=sys.stderr, flush=True)
            if total > self.max_mb:
                self.fired = "memory"; kill_browsers(f"browser memory {total:.0f} MB over {self.max_mb} MB"); return
