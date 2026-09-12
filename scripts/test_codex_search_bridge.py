"""Independent contract tests; never invoke the real Codex CLI or a network."""
import json
import http.client
import threading
import io
import signal
import codex_search_bridge as bridge
from unittest.mock import MagicMock, patch
import unittest

from codex_search_bridge import build_codex_args, parse_codex_output, make_server, SearchEngine, BridgeError, BusyError


RESULT = {
    "title": "Python documentation",
    "url": "https://docs.python.org/3/",
    "content": "Official Python documentation and library reference.",
}


def output(results=None, *, search=True, completed=True, text=None, extra=()):
    events = [{"type": "thread.started", "thread_id": "test-thread"}]
    if search:
        events.append({"type": "item.completed", "item": {
            "id": "item_1", "type": "web_search", "status": "completed",
            "action": {"type": "search", "query": "Python documentation"},
        }})
    events.extend(extra)
    events.append({"type": "item.completed", "item": {
        "id": "item_2", "type": "agent_message",
        "text": text if text is not None else json.dumps({"results": [RESULT] if results is None else results}),
    }})
    if completed:
        events.append({"type": "turn.completed", "usage": {
            "input_tokens": 123, "cached_input_tokens": 0, "output_tokens": 42,
        }})
    return "\n".join(json.dumps(event) for event in events) + "\n"


class ArgumentsTests(unittest.TestCase):
    def test_executable_and_model_are_preserved_as_distinct_arguments(self):
        args = build_codex_args("/tmp/path with spaces/codex", "gpt-5.4")
        self.assertIsInstance(args, list)
        self.assertEqual(args[0], "/tmp/path with spaces/codex")
        self.assertIn("gpt-5.4", args)
        self.assertIn("exec", args)
        self.assertIn("--json", args)

    def test_never_approval_is_global(self):
        args = build_codex_args("codex", "gpt-5.4")
        self.assertIn("-a", args)
        self.assertEqual(args[args.index("-a") + 1], "never")
        self.assertLess(args.index("-a"), args.index("exec"))

    def test_isolation_and_no_shell_contract(self):
        args = build_codex_args("codex", "gpt-5.4")
        for flag in ("--ignore-user-config", "--ignore-rules", "--ephemeral", "--sandbox"):
            self.assertIn(flag, args)
        self.assertEqual(args[args.index("--sandbox") + 1], "read-only")
        joined = " ".join(args)
        self.assertIn("project_doc_max_bytes=0", joined)
        self.assertTrue("shell_tool=false" in joined or "--disable shell_tool" in joined)
        self.assertFalse(any("dangerously" in arg for arg in args))


class ParsingTests(unittest.TestCase):
    def assertRejected(self, stdout):
        with self.assertRaises(ValueError):
            parse_codex_output(stdout)

    def test_real_shaped_success(self):
        results = parse_codex_output(output())
        self.assertEqual(len(results), 1)
        for key, value in RESULT.items():
            self.assertEqual(results[0][key], value)
        self.assertIsInstance(results[0]["engine"], str)
        self.assertTrue(results[0]["engine"].strip())

    def test_live_search_event_without_status(self):
        events = [json.loads(line) for line in output().splitlines()]
        del events[1]["item"]["status"]
        self.assertEqual(len(parse_codex_output("\n".join(map(json.dumps, events)))), 1)

    def test_requires_successful_search_and_completed_turn(self):
        self.assertRejected(output(search=False))
        self.assertRejected(output(completed=False))
        self.assertRejected(output(search=False, extra=[{
            "type": "item.started", "item": {"type": "web_search", "status": "in_progress"},
        }]))
        self.assertRejected(output(search=False, extra=[{
            "type": "item.completed", "item": {"type": "web_search", "status": "failed"},
        }]))

    def test_failure_events_override_apparent_success(self):
        failures = [
            {"type": "item.completed", "item": {"type": "error", "message": "failure"}},
            {"type": "turn.failed", "error": {"message": "private diagnostic"}},
            {"type": "error", "message": "private diagnostic"},
            {"type": "item.completed", "item": {"type": "web_search", "status": "failed"}},
        ]
        for event in failures:
            with self.subTest(event=event):
                self.assertRejected(output(extra=[event]))

    def test_rejects_malformed_stream_and_final_json(self):
        for text in ("", "not JSON", "[]", "null", '{"results": {}}', '{}',
                     '```json\n{"results": []}\n```'):
            with self.subTest(text=text):
                self.assertRejected(output(text=text))
        self.assertRejected("not JSON\n" + output())
        self.assertRejected("")
        self.assertRejected("[]\n" + output())

    def test_rejects_empty_and_wrong_typed_result_fields(self):
        for key in ("title", "url", "content"):
            for value in ("", "   ", None, [], 42):
                with self.subTest(key=key, value=value):
                    candidate = dict(RESULT, **{key: value})
                    # Invalid rows may be removed or reject the whole response;
                    # they may never be exposed as a usable search result.
                    try:
                        parsed = parse_codex_output(output([candidate]))
                    except ValueError:
                        continue
                    self.assertEqual(parsed, [])

    def test_rejects_local_private_credential_and_invalid_urls(self):
        urls = [
            "http://localhost/a", "http://localhost./a", "http://service.local/a",
            "http://127.0.0.1/a", "http://127.1/a", "http://0.0.0.0/",
            "http://10.2.3.4/", "http://172.16.0.1/", "http://192.168.1.1/",
            "http://169.254.169.254/", "http://[::1]/", "http://[fc00::1]/",
            "http://[::ffff:127.0.0.1]/", "https://user:password@example.com/",
            "file:///etc/passwd", "javascript:alert(1)", "/relative", "https://",
            "https://exa mple.com/", "https://example.com:bad/",
        ]
        for url in urls:
            with self.subTest(url=url):
                try:
                    parsed = parse_codex_output(output([dict(RESULT, url=url)]))
                except ValueError:
                    continue
                self.assertEqual(parsed, [])

    def test_deduplicates_and_limits_results_to_five(self):
        rows = [RESULT, dict(RESULT)] + [dict(RESULT, url=f"https://example.com/{n}") for n in range(9)]
        parsed = parse_codex_output(output(rows))
        self.assertLessEqual(len(parsed), 5)
        self.assertEqual(len(parsed), 5)
        self.assertEqual(len({row["url"] for row in parsed}), len(parsed))

    def test_empty_search_results_are_allowed_after_real_search(self):
        self.assertEqual(parse_codex_output(output([])), [])


class EngineTests(unittest.TestCase):
    def test_validation_happens_before_provider(self):
        engine = SearchEngine()
        with patch.object(engine, "_run") as run:
            for query in ("", "  ", "a" * 2001, None):
                with self.assertRaises(BridgeError):
                    engine.search(query)
            run.assert_not_called()
        for timeout in (0, -1, 26):
            with self.assertRaises(BridgeError):
                SearchEngine(timeout=timeout)

    def test_busy_rejects_without_provider(self):
        engine = SearchEngine()
        engine._lock.acquire()
        try:
            with patch.object(engine, "_run") as run:
                with self.assertRaises(BusyError):
                    engine.search("hello")
                run.assert_not_called()
        finally:
            engine._lock.release()

    def test_cache_reuses_and_does_not_share_mutable_results(self):
        engine = SearchEngine()
        with patch.object(engine, "_run", return_value=output()) as run:
            first = engine.search(" hello ")
            first["results"].clear()
            self.assertEqual(len(engine.search("hello")["results"]), 1)
            self.assertEqual(run.call_count, 1)

    def test_cache_expires_and_is_bounded(self):
        engine = SearchEngine()
        with patch.object(engine, "_run", return_value=output()) as run:
            with patch("codex_search_bridge.time.monotonic", return_value=0):
                engine.search("hello")
            with patch("codex_search_bridge.time.monotonic", return_value=301):
                engine.search("hello")
                self.assertEqual(run.call_count, 2)
                for n in range(33):
                    engine.search(str(n))
                count = run.call_count
                engine.search("0")
                self.assertEqual(run.call_count, count + 1)
                self.assertLessEqual(len(engine._cache), 32)

    def test_failure_releases_lock_and_does_not_cache(self):
        engine = SearchEngine()
        with patch.object(engine, "_run", side_effect=[BridgeError("unavailable"), output()]) as run:
            with self.assertRaises(BridgeError):
                engine.search("hello")
            self.assertEqual(len(engine.search("hello")["results"]), 1)
            self.assertEqual(run.call_count, 2)

    def run_fake_process(self, *, chunks, returncode=0, clock=0):
        engine = SearchEngine()
        proc = MagicMock()
        proc.stdin = io.BytesIO()
        proc.stdout = io.BytesIO()
        proc.pid = 987654321
        proc.wait.return_value = returncode
        selector = MagicMock()
        selector.__enter__.return_value = selector
        selector.get_map.side_effect = [True] * len(chunks) + [False]
        selector.select.return_value = [(MagicMock(fd=123, fileobj=proc.stdout), 1)]
        with patch("codex_search_bridge.subprocess.Popen", return_value=proc), \
             patch("codex_search_bridge.selectors.DefaultSelector", return_value=selector), \
             patch("codex_search_bridge.os.read", side_effect=chunks), \
             patch("codex_search_bridge.os.killpg") as kill, \
             patch("codex_search_bridge.time.monotonic", side_effect=clock if isinstance(clock, list) else None,
                   return_value=clock if not isinstance(clock, list) else 0):
            try:
                return engine._run("query")
            finally:
                kill.assert_called_once()
                self.assertTrue(proc.stdout.closed)
                self.assertTrue(proc.stdin.closed)

    def test_process_success_and_nonzero_exit(self):
        self.assertEqual(self.run_fake_process(chunks=[b"hello", b""]), "hello")
        with self.assertRaises(BridgeError):
            self.run_fake_process(chunks=[b"PRIVATE_DIAGNOSTIC", b""], returncode=1)

    def test_process_output_bound_and_timeout(self):
        with self.assertRaises(BridgeError):
            self.run_fake_process(chunks=[b"x" * (2 * 1024 * 1024 + 1)])
        with self.assertRaises(BridgeError):
            self.run_fake_process(chunks=[b"pending"], clock=[0, 26])


class LifecycleTests(unittest.TestCase):
    def test_shutdown_stops_registered_process_groups_and_prevents_new_spawn(self):
        proc = MagicMock(pid=321987)
        with patch.object(bridge, "_active_processes", {proc.pid: proc}), \
             patch.object(bridge, "_stopping", False), \
             patch.object(bridge.os, "killpg") as kill, \
             patch.object(bridge.subprocess, "Popen") as popen:
            bridge.stop_active_processes()
            kill.assert_called_once_with(proc.pid, signal.SIGKILL)
            proc.wait.assert_called_once()
            with self.assertRaises(BridgeError):
                bridge._spawn_codex(["fake-codex"])
            popen.assert_not_called()

    def test_sigterm_handler_cleans_up_before_exit(self):
        with patch.object(bridge.signal, "signal") as install, \
             patch.object(bridge, "stop_active_processes") as stop:
            bridge.install_shutdown_handlers()
            handlers = {call.args[0]: call.args[1] for call in install.call_args_list}
            self.assertIn(signal.SIGTERM, handlers)
            self.assertIn(signal.SIGINT, handlers)
            with self.assertRaises(SystemExit):
                handlers[signal.SIGTERM](signal.SIGTERM, None)
            stop.assert_called_once()

    def test_spawn_capacity_is_bounded_before_popen(self):
        with patch.object(bridge, "_active_processes", {1: MagicMock(), 2: MagicMock()}), \
             patch.object(bridge, "_stopping", False), \
             patch.object(bridge.subprocess, "Popen") as popen:
            with self.assertRaises(BusyError):
                bridge._spawn_codex(["fake-codex"])
            popen.assert_not_called()

    def test_shutdown_cannot_miss_process_mid_spawn(self):
        entered = threading.Event()
        release = threading.Event()
        shutdown_started = threading.Event()
        errors = []
        proc = MagicMock(pid=321988)
        def spawn(*args, **kwargs):
            entered.set()
            if not release.wait(timeout=2):
                raise RuntimeError("test spawn release timeout")
            return proc
        def run_spawn():
            try:
                bridge._spawn_codex(["fake-codex"])
            except Exception as exc:
                errors.append(exc)
        def run_shutdown():
            shutdown_started.set()
            try:
                bridge.stop_active_processes()
            except Exception as exc:
                errors.append(exc)
        with patch.object(bridge, "_active_processes", {}), \
             patch.object(bridge, "_stopping", False), \
             patch.object(bridge.os, "killpg") as kill, \
             patch.object(bridge.subprocess, "Popen", side_effect=spawn):
            spawning = threading.Thread(target=run_spawn, daemon=True)
            stopping = threading.Thread(target=run_shutdown, daemon=True)
            spawning.start()
            self.assertTrue(entered.wait(timeout=2))
            stopping.start()
            self.assertTrue(shutdown_started.wait(timeout=2))
            release.set()
            spawning.join(timeout=2)
            stopping.join(timeout=2)
            self.assertFalse(spawning.is_alive())
            self.assertFalse(stopping.is_alive())
            self.assertEqual(errors, [])
            kill.assert_called_once_with(proc.pid, signal.SIGKILL)
            self.assertEqual(bridge._active_processes, {})
            self.assertTrue(bridge._stopping)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        class FakeEngine:
            def __init__(self):
                self.queries = []
                self.error = False

            def search(self, query):
                self.queries.append(query)
                if self.error:
                    raise RuntimeError("PRIVATE_SENTINEL_DIAGNOSTIC")
                return {"results": [dict(RESULT, engine="codex")]}

        self.engine = FakeEngine()
        self.server = make_server(self.engine, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, headers=None, method="GET"):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        try:
            conn.request(method, path, headers=headers or {})
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read().decode()
        finally:
            conn.close()

    def test_search_returns_searxng_contract(self):
        status, headers, body = self.request("/search?q=Python%20documentation&format=json&categories=general")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["results"][0]["url"], RESULT["url"])
        self.assertEqual(self.engine.queries, ["Python documentation"])
        self.assertFalse(any(key.lower() == "access-control-allow-origin" for key in headers))

    def test_health_does_not_search(self):
        status, _, body = self.request("/health")
        self.assertEqual(status, 200)
        self.assertIsInstance(json.loads(body), dict)
        self.assertEqual(self.engine.queries, [])

    def test_browser_and_host_requests_rejected_before_search(self):
        for headers in ({"Host": "evil.example"}, {"Origin": "https://evil.example"},
                        {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Mode": "navigate"}):
            with self.subTest(headers=headers):
                status, _, _ = self.request("/search?q=private&format=json", headers)
                self.assertGreaterEqual(status, 400)
        self.assertEqual(self.engine.queries, [])

    def test_empty_overlong_unknown_and_non_json_requests_rejected(self):
        paths = ["/search?q=&format=json", "/search?q=%20%20&format=json",
                 "/search?q=" + "a" * 2001 + "&format=json",
                 "/search?q=hello&format=html", "/unknown"]
        for path in paths:
            with self.subTest(path=path[:70]):
                status, _, _ = self.request(path)
                self.assertGreaterEqual(status, 400)
        self.assertEqual(self.engine.queries, [])

    def test_exception_details_do_not_leak(self):
        self.engine.error = True
        status, _, body = self.request("/search?q=hello&format=json")
        self.assertGreaterEqual(status, 500)
        self.assertNotIn("PRIVATE_SENTINEL_DIAGNOSTIC", body)


if __name__ == "__main__":
    unittest.main()
