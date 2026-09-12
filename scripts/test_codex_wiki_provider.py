"""Independent text provider tests; all completion/search engines are fake."""
import json
import http.client
import threading
from unittest.mock import patch
import unittest

from codex_wiki_provider import parse_completion_output, CompletionEngine, make_server


def completion_output(text="Final report", *, completed=True, extra=()):
    events = [{"type": "thread.started", "thread_id": "fake"},
              {"type": "item.completed", "item": {"type": "agent_message", "text": "I will research this now."}}]
    events.extend(extra)
    events.append({"type": "item.completed", "item": {"type": "agent_message", "text": text}})
    if completed:
        events.append({"type": "turn.completed", "usage": {"input_tokens": 1, "output_tokens": 1}})
    return "\n".join(json.dumps(event) for event in events)


class CompletionParserTests(unittest.TestCase):
    def test_final_artifact_excludes_prior_progress_commentary(self):
        self.assertEqual(parse_completion_output(completion_output("# Research report\nVerified content.")),
                         "# Research report\nVerified content.")

    def test_requires_successful_completion(self):
        failures = [{"type": "error", "message": "SECRET"},
                    {"type": "turn.failed", "error": {"message": "SECRET"}},
                    {"type": "item.completed", "item": {"type": "error", "message": "SECRET"}},
                    {"type": "item.completed", "item": {"type": "command_execution", "status": "failed"}}]
        for event in failures:
            with self.subTest(event=event), self.assertRaises(ValueError):
                parse_completion_output(completion_output(extra=[event]))
        with self.assertRaises(ValueError):
            parse_completion_output(completion_output(completed=False))

    def test_empty_invalid_and_oversized_outputs_fail_closed(self):
        for text in ("", "  ", None, [], 23):
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_completion_output(completion_output(text))
        for stream in ("", "not JSON", "[]", "not JSON\n" + completion_output(),
                       completion_output("x" * (2 * 1024 * 1024 + 1))):
            with self.subTest(stream=stream[:30]), self.assertRaises(ValueError):
                parse_completion_output(stream)


class CompletionEngineTests(unittest.TestCase):
    def test_allowlisted_models_and_text_roles(self):
        engine = CompletionEngine()
        messages = [{"role": role, "content": "hello"} for role in ("system", "developer", "user", "assistant")]
        with patch.object(engine, "_run", return_value=completion_output()) as run:
            for model in ("gpt-6-astra", "gpt-5.6-luna"):
                self.assertEqual(engine.complete(messages, model), "Final report")
            self.assertEqual(run.call_count, 2)

    def test_accepts_text_blocks(self):
        engine = CompletionEngine()
        with patch.object(engine, "_run", return_value=completion_output()):
            result = engine.complete([{"role": "user", "content": [{"type": "text", "text": "hello"}]}], "gpt-6-astra")
            self.assertEqual(result, "Final report")

    def test_invalid_model_role_content_and_size_never_call_provider(self):
        engine = CompletionEngine()
        invalid_messages = [[], None, {}, [{"role": "tool", "content": "hello"}],
            [{"role": "user", "content": ""}], [{"role": "user", "content": 3}],
            [{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "http://example.com/image"}}]}],
            [{"role": "user", "content": "x" * (1024 * 1024 + 1)}]]
        with patch.object(engine, "_run") as run:
            for messages in invalid_messages:
                with self.subTest(messages=str(messages)[:80]), self.assertRaises(ValueError):
                    engine.complete(messages, "gpt-6-astra")
            for model in ("arbitrary-model", "", None, "--dangerously-bypass-approvals-and-sandbox"):
                with self.subTest(model=model), self.assertRaises(ValueError):
                    engine.complete([{"role": "user", "content": "hello"}], model)
            run.assert_not_called()

    def test_failure_does_not_hold_lock_and_success_is_not_cached(self):
        engine = CompletionEngine()
        messages = [{"role": "user", "content": "hello"}]
        with patch.object(engine, "_run", side_effect=[ValueError("failure"), completion_output(), completion_output()]) as run:
            with self.assertRaises(ValueError):
                engine.complete(messages, "gpt-6-astra")
            engine.complete(messages, "gpt-6-astra")
            engine.complete(messages, "gpt-6-astra")
            self.assertEqual(run.call_count, 3)


class CompletionHTTPTests(unittest.TestCase):
    def setUp(self):
        class FakeSearch:
            def search(self, query):
                return {"results": []}
        class FakeCompletion:
            def __init__(self):
                self.calls = []
                self.fail = False
            def complete(self, messages, model):
                self.calls.append((messages, model))
                if self.fail:
                    raise RuntimeError("SECRET_PRIVATE_DIAGNOSTIC")
                return "# Report\nFinal only — checked."
        self.engine = FakeCompletion()
        self.server = make_server(FakeSearch(), self.engine, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, payload=None, *, headers=None, path="/v1/chat/completions", method="POST", raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=3)
        request_headers = {"Content-Type": "application/json"}
        request_headers.update(headers or {})
        try:
            conn.request(method, path, body=raw if raw is not None else json.dumps(payload), headers=request_headers)
            response = conn.getresponse()
            return response.status, dict(response.getheaders()), response.read().decode()
        finally:
            conn.close()

    def payload(self, **changes):
        return dict({"model": "gpt-6-astra", "messages": [{"role": "user", "content": "make report"}]}, **changes)

    def test_standard_completion_json(self):
        status, headers, body = self.request(self.payload())
        self.assertEqual(status, 200)
        payload = json.loads(body)
        self.assertEqual(payload["object"], "chat.completion")
        self.assertEqual(payload["choices"][0]["message"], {"role": "assistant", "content": "# Report\nFinal only — checked."})
        self.assertEqual(payload["choices"][0]["finish_reason"], "stop")
        self.assertEqual(len(self.engine.calls), 1)
        self.assertFalse(any(key.lower() == "access-control-allow-origin" for key in headers))

    def test_sse_final_content_stop_and_done(self):
        status, headers, body = self.request(self.payload(stream=True))
        self.assertEqual(status, 200)
        self.assertIn("text/event-stream", headers.get("Content-Type", ""))
        data = [line[6:] for line in body.splitlines() if line.startswith("data: ")]
        self.assertEqual(data[-1], "[DONE]")
        chunks = [json.loads(line) for line in data[:-1]]
        text = "".join(chunk["choices"][0]["delta"].get("content", "") for chunk in chunks)
        self.assertEqual(text, "# Report\nFinal only — checked.")
        self.assertEqual(chunks[-1]["choices"][0]["finish_reason"], "stop")

    def test_app_origin_without_port_is_allowed(self):
        status, _, _ = self.request(self.payload(), headers={"Origin": "http://localhost"})
        self.assertEqual(status, 200)
        status, _, _ = self.request(self.payload(), headers={"Origin": "http://localhost", "Sec-Fetch-Site": "same-origin"})
        self.assertGreaterEqual(status, 400)
        self.assertEqual(len(self.engine.calls), 1)

    def test_browser_and_foreign_host_rejected(self):
        for headers in ({"Host": "evil.example"}, {"Origin": "https://evil.example"}, {"Sec-Fetch-Mode": "cors"}):
            with self.subTest(headers=headers):
                status, _, _ = self.request(self.payload(), headers=headers)
                self.assertGreaterEqual(status, 400)
        self.assertEqual(self.engine.calls, [])

    def test_tools_and_images_are_explicitly_rejected(self):
        payloads = [self.payload(tools=[{"type": "function", "function": {"name": "shell"}}]),
                    self.payload(messages=[{"role": "user", "content": [{"type": "image_url", "image_url": {"url": "https://example.com/a"}}]}])]
        for payload in payloads:
            with self.subTest(payload=payload):
                status, _, _ = self.request(payload)
                self.assertEqual(status, 400)
        self.assertEqual(self.engine.calls, [])

    def test_bad_body_chunked_and_unknown_route_rejected(self):
        for raw, headers, path in [("not JSON", {}, "/v1/chat/completions"),
                                   ("{}", {"Transfer-Encoding": "chunked"}, "/v1/chat/completions"),
                                   ("{}", {"Content-Length": str(1024 * 1024 + 1)}, "/v1/chat/completions"),
                                   ("{}", {}, "/unknown")]:
            with self.subTest(path=path, headers=headers, length=len(raw)):
                status, _, _ = self.request(raw=raw, headers=headers, path=path)
                self.assertGreaterEqual(status, 400)
        self.assertEqual(self.engine.calls, [])

    def test_provider_failures_are_sanitized(self):
        self.engine.fail = True
        status, _, body = self.request(self.payload())
        self.assertGreaterEqual(status, 500)
        self.assertNotIn("SECRET_PRIVATE_DIAGNOSTIC", body)

    def test_existing_search_and_health_remain_available(self):
        for path in ("/health", "/search?q=hello&format=json"):
            status, _, body = self.request(path=path, method="GET")
            self.assertEqual(status, 200)
            self.assertIsInstance(json.loads(body), dict)
        self.assertEqual(self.engine.calls, [])


if __name__ == "__main__":
    unittest.main()
