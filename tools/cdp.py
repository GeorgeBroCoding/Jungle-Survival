"""Minimal Chrome DevTools Protocol client over a hand-rolled WebSocket.

There is no node and no puppeteer on this machine, but there is Chrome, and
CDP is just JSON over a WebSocket. This is enough of one to drive the game:
navigate, run JS in the page, collect console errors, and grab the canvas.

Runs Chrome headless on its own port with its own throwaway profile so it can
never touch the user's real browser or their logged-in session.
"""
import base64, json, os, re, select, socket, struct, subprocess, sys, time, urllib.request


CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HERE = os.path.dirname(os.path.abspath(__file__))
PROFILE = os.path.join(HERE, "chromeprof")  # suffixed per port below
# One debug port means two harness runs fight over the same browser and the
# loser dies mid-screenshot. Set JK_CDP_PORT to run them side by side.
PORT = int(os.environ.get("JK_CDP_PORT", "9333"))
# A profile directory can only be open once, so two browsers need two.
PROFILE = PROFILE + ("" if PORT == 9333 else "-%d" % PORT)


class WS:
    """Just enough RFC6455 for CDP: text frames out (masked), frames in."""

    def __init__(self, url):
        m = re.match(r"ws://([^:/]+):(\d+)(/.*)", url)
        host, port, path = m.group(1), int(m.group(2)), m.group(3)
        self.sock = socket.create_connection((host, port), timeout=60)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            "GET %s HTTP/1.1\r\nHost: %s:%d\r\nUpgrade: websocket\r\n"
            "Connection: Upgrade\r\nSec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n" % (path, host, port, key)
        )
        self.sock.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(4096)
        assert b"101" in buf.split(b"\r\n")[0], buf[:200]
        self.buf = buf.split(b"\r\n\r\n", 1)[1]

    def _recv(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send(self, text):
        payload = text.encode()
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        n = len(payload)
        if n < 126:
            header = struct.pack("!BB", 0x81, 0x80 | n)
        elif n < 65536:
            header = struct.pack("!BBH", 0x81, 0x80 | 126, n)
        else:
            header = struct.pack("!BBQ", 0x81, 0x80 | 127, n)
        self.sock.sendall(header + mask + masked)

    def recv(self):
        """Returns one complete message, reassembling continuation frames."""
        data = b""
        while True:
            b0, b1 = struct.unpack("!BB", self._recv(2))
            fin, opcode = b0 & 0x80, b0 & 0x0F
            n = b1 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._recv(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._recv(8))[0]
            if b1 & 0x80:                       # server frames shouldn't be masked
                mask = self._recv(4)
                payload = bytes(c ^ mask[i % 4] for i, c in enumerate(self._recv(n)))
            else:
                payload = self._recv(n)
            if opcode == 0x8:
                raise EOFError("websocket closed by peer")
            if opcode == 0x9:                   # ping -> pong
                continue
            data += payload
            if fin:
                return data.decode("utf-8", "replace")

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


class Chrome:
    def __init__(self, width=1280, height=760, gpu="swiftshader"):
        os.makedirs(PROFILE, exist_ok=True)
        args = [
            CHROME, "--headless=new", "--no-first-run", "--no-default-browser-check",
            "--disable-extensions", "--mute-audio", "--no-sandbox",
            "--remote-debugging-port=%d" % PORT,
            "--user-data-dir=" + PROFILE,
            "--window-size=%d,%d" % (width, height),
            "--hide-scrollbars",
        ]
        if gpu == "swiftshader":
            args += ["--use-gl=angle", "--use-angle=swiftshader",
                     "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"]
        self.proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.ws = None
        self.msg_id = 0
        self.events = []
        target = None
        for _ in range(100):
            time.sleep(0.3)
            try:
                raw = urllib.request.urlopen("http://127.0.0.1:%d/json" % PORT, timeout=3).read()
                for t in json.loads(raw):
                    if t.get("type") == "page":
                        target = t
                        break
                if target:
                    break
            except Exception:
                pass
        assert target, "Chrome never exposed a page target"
        self.ws = WS(target["webSocketDebuggerUrl"])
        self.call("Runtime.enable")
        self.call("Log.enable")
        self.call("Page.enable")
        # Without this Chrome happily serves index.html from its cache, and a
        # measurement run silently tests the previous edit. That cost several
        # confusing results before it was spotted.
        self.call("Network.enable")
        self.call("Network.setCacheDisabled", {"cacheDisabled": True})

    def call(self, method, params=None, timeout=120):
        self.msg_id += 1
        mid = self.msg_id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError("%s: %s" % (method, msg["error"]))
                return msg.get("result", {})
            if "method" in msg:
                self.events.append(msg)
        raise TimeoutError(method)

    def js(self, expr, timeout=120):
        r = self.call("Runtime.evaluate", {
            "expression": expr, "returnByValue": True, "awaitPromise": True,
        }, timeout=timeout)
        if r.get("exceptionDetails"):
            return {"__exception": r["exceptionDetails"].get("text", "")
                    + " " + str(r["exceptionDetails"].get("exception", {}).get("description", ""))}
        return r.get("result", {}).get("value")

    def goto(self, url, settle=3.0):
        self.call("Page.navigate", {"url": url})
        time.sleep(settle)

    def shot_checked(self, path, drain=None):
        """Screenshot, but reject a frame that came back empty.

        Software rendering here runs at about one frame a second, so a capture
        can land between frames and return pure black. That is not the scene
        being black, and mistaking one for the other wastes a lot of time.
        """
        import struct
        import zlib
        for attempt in range(4):
            self.shot(path)
            with open(path, 'rb') as f:
                data = f.read()
            # Cheap emptiness test: a frame with any content compresses worse
            # than a uniform one. 12KB for a megapixel PNG means flat colour.
            if len(data) > 12000 or attempt == 3:
                return
            if drain:
                self.drain(drain)
            else:
                self.drain(1.5)

    def shot(self, path, full=False):
        r = self.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": full})
        open(path, "wb").write(base64.b64decode(r["data"]))
        return path

    def console(self):
        """Console messages and page exceptions collected so far."""
        out = []
        for e in self.events:
            m = e.get("method")
            if m == "Runtime.consoleAPICalled":
                args = " ".join(str(a.get("value", a.get("description", "")))
                                for a in e["params"].get("args", []))
                out.append((e["params"].get("type", "log"), args))
            elif m == "Runtime.exceptionThrown":
                d = e["params"].get("exceptionDetails", {})
                out.append(("exception", d.get("text", "") + " " +
                            str(d.get("exception", {}).get("description", ""))))
            elif m == "Log.entryAdded":
                en = e["params"]["entry"]
                out.append((en.get("level", "log"), en.get("text", "")))
        return out

    def drain(self, seconds):
        """Let the page run, collecting events.

        Uses select() to wait for a frame to *start* rather than putting a
        timeout on the socket. A timeout could fire after the 2-byte header had
        already been consumed, losing it and desynchronising the stream - which
        shows up much later as a connection reset.
        """
        end = time.time() + seconds
        while True:
            left = end - time.time()
            if left <= 0:
                return
            if self.ws.buf:
                ready = True
            else:
                ready = bool(select.select([self.ws.sock], [], [], min(0.2, left))[0])
            if not ready:
                continue
            try:
                self.events.append(json.loads(self.ws.recv()))
            except Exception:
                return

    def close(self):
        try:
            if self.ws:
                self.ws.close()
        finally:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=10)
            except Exception:
                self.proc.kill()
