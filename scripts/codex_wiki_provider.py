#!/usr/bin/env python3
"""Local text-only OpenAI-compatible provider using existing Codex login."""
import argparse
import json
import threading
import time
import uuid
from http.server import ThreadingHTTPServer

from codex_search_bridge import (BridgeError, BusyError, BridgeHandler, SearchEngine,
                                 DEFAULT_CODEX, MAX_OUTPUT, build_codex_args,
                                 run_codex_prompt, install_shutdown_handlers)

MAX_BODY = 1024 * 1024
MODELS = ("gpt-6-astra", "gpt-5.6-luna")


def parse_completion_output(stdout):
    if not isinstance(stdout, str) or len(stdout.encode("utf-8")) > MAX_OUTPUT:
        raise BridgeError("Invalid completion response")
    final, completed = None, False
    try:
        for line in stdout.splitlines():
            if not line.strip():
                continue
            event = json.loads(line)
            if not isinstance(event, dict):
                raise ValueError()
            kind = event.get("type")
            item = event.get("item", {})
            if not isinstance(item, dict):
                raise ValueError()
            if (kind in ("error", "turn.failed", "item.failed") or event.get("error")
                    or item.get("type") == "error" or item.get("error")
                    or item.get("status") in ("failed", "error", "cancelled")):
                raise ValueError()
            if kind == "item.completed" and item.get("type") == "agent_message":
                final = item.get("text")
                completed = False
            if kind == "turn.completed":
                completed = True
        if not completed or not isinstance(final, str) or not final.strip():
            raise ValueError()
    except (ValueError, TypeError, RecursionError):
        raise BridgeError("Invalid completion response") from None
    return final


def validate_messages(messages):
    if not isinstance(messages, list) or not messages:
        raise BridgeError("Invalid messages")
    normalized = []
    for message in messages:
        if not isinstance(message, dict) or message.get("role") not in ("system", "developer", "user", "assistant"):
            raise BridgeError("Only text conversation messages are supported")
        if any(key in message for key in ("tool_calls", "function_call", "tool_call_id")):
            raise BridgeError("Tool calls are not supported")
        content = message.get("content")
        if isinstance(content, list):
            if not content or any(not isinstance(part, dict) or part.get("type") != "text"
                                  or not isinstance(part.get("text"), str) for part in content):
                raise BridgeError("Only text content is supported")
            content = "\n".join(part["text"] for part in content)
        if not isinstance(content, str) or not content.strip():
            raise BridgeError("Only text content is supported")
        normalized.append({"role": message["role"], "content": content})
    try:
        size = len(json.dumps(messages, ensure_ascii=False).encode("utf-8"))
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise BridgeError("Invalid messages") from None
    if size > MAX_BODY:
        raise BridgeError("Messages too large")
    return normalized


class CompletionEngine:
    def __init__(self, codex_path=DEFAULT_CODEX, timeout=180):
        if not 0 < timeout <= 180:
            raise BridgeError("Invalid completion timeout")
        self.codex_path, self.timeout = codex_path, timeout
        self._lock = threading.Lock()

    def complete(self, messages, model):
        if model not in MODELS:
            raise BridgeError("Unsupported model")
        normalized = validate_messages(messages)
        if not self._lock.acquire(blocking=False):
            raise BusyError("Completion busy; retry shortly")
        try:
            return parse_completion_output(self._run(normalized, model))
        finally:
            self._lock.release()

    def _run(self, messages, model):
        args = build_codex_args(self.codex_path, model)
        args.remove("--search")
        args[-1:-1] = ["-c", 'web_search="disabled"']
        prompt = (
            "You are the text generation provider for LLM Wiki. Fulfill the following "
            "conversation, respecting system/developer instructions ahead of user text. "
            "Return ONLY the requested final artifact or answer in the exact requested "
            "format. Never emit progress reports, plans about your process, or commentary "
            "before the artifact. Use supplied evidence; do not invent sources. No tools, "
            "web searches, file reads, or command execution are available or needed. "
            "The conversation is encoded as JSON:\n" + json.dumps(messages, ensure_ascii=False)
        ).encode("utf-8")
        return run_codex_prompt(args, prompt, self.timeout)


class ProviderHandler(BridgeHandler):
    def _local(self):
        port = self.server.server_address[1]
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origins = self.headers.get_all("Origin", [])
        allowed = (len(self.headers.get_all("Host", [])) == 1
                   and self.headers.get("Host", "").lower() in hosts
                   and not any(key.lower().startswith("sec-fetch-") for key in self.headers)
                   and len(origins) <= 1
                   and (not origins or origins[0] in ({f"http://{host}" for host in hosts} | {"http://localhost"})))
        if not allowed:
            self._send(403, {"error": "Local requests only"})
        return allowed

    def do_GET(self):
        if self.path == "/v1/models":
            if self._local():
                self._send(200, {"object": "list", "data": [
                    {"id": model, "object": "model", "created": 0, "owned_by": "codex"}
                    for model in MODELS]})
            return
        super().do_GET()

    def do_POST(self):
        if not self._local():
            return
        if self.path != "/v1/chat/completions":
            self._send(404, {"error": "Not found"})
            return
        try:
            lengths = self.headers.get_all("Content-Length", [])
            if self.headers.get("Transfer-Encoding") or len(lengths) != 1:
                raise ValueError()
            size = int(lengths[0])
            if not 0 < size <= MAX_BODY:
                raise ValueError()
            self.connection.settimeout(10)
            body = self.rfile.read(size)
            if len(body) != size:
                raise ValueError()
            request = json.loads(body)
            if not isinstance(request, dict):
                raise ValueError()
            if any(key in request for key in ("tools", "tool_choice", "functions", "function_call")):
                raise ValueError()
            if request.get("model") not in MODELS or not isinstance(request.get("stream", False), bool):
                raise ValueError()
            messages = validate_messages(request.get("messages"))
        except (ValueError, TypeError, UnicodeError, RecursionError, OSError):
            self._send(400, {"error": "Invalid text completion request"})
            return
        try:
            content = self.server.completion_engine.complete(messages, request["model"])
        except BusyError:
            self._send(429, {"error": "Completion busy; retry shortly"})
            return
        except Exception:
            self._send(503, {"error": "Completion unavailable; check Codex login and retry"})
            return
        common = {"id": "chatcmpl-" + uuid.uuid4().hex, "created": int(time.time()), "model": request["model"]}
        if not request.get("stream", False):
            self._send(200, dict(common, object="chat.completion", choices=[{
                "index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]))
            return
        chunks = [dict(common, object="chat.completion.chunk", choices=[{
            "index": 0, "delta": {"role": "assistant", "content": content}, "finish_reason": None}]),
            dict(common, object="chat.completion.chunk", choices=[{
                "index": 0, "delta": {}, "finish_reason": "stop"}])]
        body = ("".join("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n" for chunk in chunks)
                + "data: [DONE]\n\n").encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


def make_server(search_engine, completion_engine, host="127.0.0.1", port=19829):
    if host != "127.0.0.1":
        raise BridgeError("Only 127.0.0.1 binding is supported")
    server = ThreadingHTTPServer((host, port), ProviderHandler)
    server.daemon_threads = True
    server.engine, server.completion_engine = search_engine, completion_engine
    return server


def main():
    install_shutdown_handlers()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", choices=["127.0.0.1"], default="127.0.0.1")
    parser.add_argument("--port", type=int, default=19829)
    parser.add_argument("--codex", default=DEFAULT_CODEX)
    parser.add_argument("--model", choices=MODELS, default="gpt-5.6-luna")
    args = parser.parse_args()
    with make_server(SearchEngine(args.codex, args.model), CompletionEngine(args.codex),
                     args.host, args.port) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
