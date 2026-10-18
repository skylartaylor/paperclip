import hashlib
import importlib.util
import io
import json
import pathlib
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('bridge', pathlib.Path(__file__).parents[1] / 'paperclip-github-mcp.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
AGENT, COMPANY, RUN, TASK, PROJECT = [f'00000000-0000-4000-8000-{n:012d}' for n in range(1, 6)]
ENV = dict(PAPERCLIP_API_KEY='unit-test-run-credential', PAPERCLIP_AGENT_ID=AGENT, PAPERCLIP_COMPANY_ID=COMPANY, PAPERCLIP_RUN_ID=RUN, PAPERCLIP_TASK_ID=TASK)

class Server(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def send(self, status, value):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(value).encode())
    def do_GET(self):
        self.server.calls.append((self.command, self.path, dict(self.headers), None))
        if self.server.redirect:
            self.send_response(302)
            self.send_header('Location', 'http://not-paperclip.invalid/steal')
            self.end_headers()
        elif self.path == '/api/issues/' + TASK:
            self.send(200, dict(id=TASK, companyId=COMPANY, projectId=PROJECT))
        elif self.path == '/api/plugins/tools':
            self.send(200, [{'name': 'paperclip-github-plugin:get_issue'}, {'name': 'other:read'}])
        else:
            self.send(404, {'reasonCode': 'not_found'})
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.server.calls.append((self.command, self.path, dict(self.headers), body))
        if body['tool'].endswith(':add_issue_comment'):
            self.send(409, {'reasonCode': 'approval_required', 'actionRequestId': 'synthetic-action', 'interactionId': 'synthetic-interaction'})
        else:
            self.send(200, {'ok': True})

class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Server)
        self.server.calls, self.server.redirect = [], False
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = bridge.Client(AGENT, 'http://127.0.0.1:%d' % self.server.server_port, ENV)
    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
    def body(self):
        body = 'NON-PUBLISHING synthetic approval-boundary test'
        return dict(repository='https://github.com/example/repository', issueNumber=1, body=body, bodySha256=hashlib.sha256(body.encode()).hexdigest())
    def test_discovers_only_installed_github_plugin(self):
        self.assertEqual(self.client.call('discover_github_tools', {}), {'tools': [{'name': 'paperclip-github-plugin:get_issue'}]})
        self.assertEqual(self.server.calls[0][2]['Authorization'], 'Bearer ' + ENV['PAPERCLIP_API_KEY'])
    def test_read_is_bound_to_current_task_and_run(self):
        self.client.call('get_linked_issue', {})
        req = self.server.calls[-1][3]
        self.assertEqual(req['parameters'], {'paperclipIssueId': TASK})
        self.assertEqual(req['runContext'], dict(agentId=AGENT, companyId=COMPANY, runId=RUN, projectId=PROJECT))
    def test_linked_comments_have_no_target_override(self):
        with self.assertRaises(bridge.Failure): self.client.call('get_linked_comments', {'paperclipIssueId': RUN})
        self.assertEqual(self.server.calls, [])
    def test_preparation_returns_human_gate_without_retry(self):
        result = self.client.call('prepare_issue_comment', self.body())
        self.assertEqual(result['status'], 'pending_human_approval')
        self.assertEqual(result['actionRequestId'], 'synthetic-action')
        posts = [c for c in self.server.calls if c[0] == 'POST']
        self.assertEqual(len(posts), 1)
        self.assertEqual(posts[0][3]['parameters']['paperclipIssueId'], TASK)
        self.assertNotIn('bodySha256', posts[0][3]['parameters'])
    def test_mismatched_body_is_never_sent(self):
        args = self.body(); args['body'] += ' changed'
        with self.assertRaises(bridge.Failure): self.client.call('prepare_issue_comment', args)
        self.assertEqual(self.server.calls, [])
    def test_identity_override_is_never_sent(self):
        args = self.body(); args['paperclipIssueId'] = RUN
        with self.assertRaises(bridge.Failure): self.client.call('prepare_issue_comment', args)
        self.assertEqual(self.server.calls, [])
    def test_arbitrary_tool_and_approval_are_not_exposed(self):
        for name in ('approve_action', 'execute', 'create_pull_request'):
            with self.assertRaises(bridge.Failure): self.client.call(name, {})
        self.assertEqual(self.server.calls, [])
    def test_misbound_agent_is_rejected(self):
        with self.assertRaises(bridge.Failure): bridge.Client(COMPANY, env=ENV)
    def test_missing_context_is_rejected(self):
        env = dict(ENV); del env['PAPERCLIP_RUN_ID']
        with self.assertRaises(bridge.Failure): bridge.Client(AGENT, env=env)
    def test_remote_or_credentialed_api_origin_is_rejected(self):
        for url in ('https://api.github.com', 'http://user:pass@127.0.0.1:3100', 'http://127.0.0.1:3100/api'):
            with self.assertRaises(bridge.Failure): bridge.Client(AGENT, url, ENV)
    def test_redirect_cannot_forward_run_credential(self):
        self.server.redirect = True
        with self.assertRaises(bridge.Failure): self.client.call('discover_github_tools', {})
        self.assertEqual(len(self.server.calls), 1)
    def test_rejected_api_does_not_retry(self):
        with self.assertRaisesRegex(bridge.Failure, 'HTTP 404'): self.client.request('GET', '/not-allowed')
        self.assertEqual(len(self.server.calls), 1)
    def test_exact_run_credential_is_redacted(self):
        self.assertEqual(self.client.redact({'error': ENV['PAPERCLIP_API_KEY']}), {'error': '[REDACTED]'})
    def test_protocol_lists_only_bounded_methods_and_no_execution(self):
        request = '\n'.join(json.dumps({'jsonrpc': '2.0', 'id': i, 'method': name}) for i, name in enumerate(['initialize', 'tools/list', 'approve'])) + '\n'
        output = io.StringIO(); bridge.serve(AGENT, 'http://127.0.0.1:3100', io.StringIO(request), output)
        results = [json.loads(x) for x in output.getvalue().splitlines()]
        self.assertEqual(len(results[1]['result']['tools']), 4)
        self.assertIn('error', results[2])
        self.assertEqual(self.server.calls, [])

if __name__ == '__main__': unittest.main()
