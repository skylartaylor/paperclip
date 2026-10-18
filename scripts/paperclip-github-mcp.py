#!/usr/bin/env python3
"""Run-scoped MCP facade for installed GitHub Sync tools, not GitHub credentials.

All execution goes through Paperclip's authenticated plugin API and tool gateway.
There is intentionally no approval, direct GitHub HTTP, or arbitrary-tool method.
"""
import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

PREFIX = 'paperclip-github-plugin:'
MAX_MESSAGE = 1048576
MAX_RESPONSE = 262144
READ_TOOLS = {'get_linked_issue': 'get_issue', 'get_linked_comments': 'list_issue_comments'}

def schema(properties=None, required=None):
    return {'type': 'object', 'properties': properties or {}, 'required': required or [], 'additionalProperties': False}

TOOLS = [
    {'name': 'discover_github_tools', 'description': 'Discover the installed local GitHub Sync plugin tools permitted for this run. Does not connect to Paperclip Cloud.', 'inputSchema': schema(), 'annotations': {'readOnlyHint': True, 'openWorldHint': False}},
    *[{'name': name, 'description': 'Read the GitHub ' + ('issue' if name == 'get_linked_issue' else 'comments') + ' linked to this run’s current Paperclip task.', 'inputSchema': schema(), 'annotations': {'readOnlyHint': True, 'openWorldHint': True}} for name in READ_TOOLS],
    {'name': 'prepare_issue_comment', 'description': 'Request the normal broker action for the exact body/hash on this task’s linked issue. Human approval is still required by the company write policy. Never approves or executes a pending action. Do not use without task-specific authorization.', 'inputSchema': schema({'repository': {'type': 'string'}, 'issueNumber': {'type': 'integer', 'minimum': 1}, 'body': {'type': 'string', 'minLength': 1, 'maxLength': 32768}, 'bodySha256': {'type': 'string', 'pattern': '^[a-f0-9]{64}$'}}, ['repository', 'issueNumber', 'body', 'bodySha256']), 'annotations': {'readOnlyHint': False, 'destructiveHint': False, 'openWorldHint': True}},
]

class Failure(Exception):
    pass

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Failure('Paperclip API redirects are refused')

class Client:
    def __init__(self, coordinator_id, api_origin='http://127.0.0.1:3100', env=None):
        self.env = dict(os.environ if env is None else env)
        self.token = self.env.get('PAPERCLIP_API_KEY', '')
        if not self.token:
            raise Failure('Missing run-scoped Paperclip identity; start through Paperclip')
        self.agent = self._uuid('PAPERCLIP_AGENT_ID')
        self.company = self._uuid('PAPERCLIP_COMPANY_ID')
        self.run = self._uuid('PAPERCLIP_RUN_ID')
        self.task = self._uuid('PAPERCLIP_TASK_ID')
        if self.agent != str(uuid.UUID(coordinator_id)):
            raise Failure('This bridge is configured for the GitHub Coordinator only')
        self.origin = api_origin.rstrip('/')
        parsed = urllib.parse.urlsplit(self.origin)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment:
            raise Failure('The bridge requires the configured loopback Paperclip API origin')
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.project = None

    def _uuid(self, name):
        try:
            return str(uuid.UUID(self.env[name]))
        except (KeyError, ValueError):
            raise Failure('Missing or invalid run context: ' + name) from None

    def request(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.origin + '/api' + path, data=data, method=method, headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json', 'X-Paperclip-Run-Id': self.run})
        try:
            response = self.opener.open(req, timeout=15)
        except urllib.error.HTTPError as error:
            response = error
        except (OSError, urllib.error.URLError, TimeoutError):
            raise Failure('Paperclip API unavailable; no retry was attempted') from None
        with response:
            raw = response.read(MAX_RESPONSE + 1)
            if len(raw) > MAX_RESPONSE:
                raise Failure('Paperclip API response exceeded the bounded output limit')
            try:
                result = json.loads(raw)
            except (ValueError, UnicodeDecodeError):
                raise Failure('Paperclip API returned non-JSON; no retry was attempted') from None
            status = response.code
        if status == 409 and isinstance(result, dict) and result.get('reasonCode') == 'approval_required':
            return {'status': 'pending_human_approval', **result}
        if status >= 400:
            reason = result.get('reasonCode', result.get('code', 'request_rejected')) if isinstance(result, dict) else 'request_rejected'
            raise Failure('Paperclip API rejected the request (HTTP %s, %s); no retry was attempted' % (status, reason))
        return result

    def run_context(self):
        if self.project is None:
            task = self.request('GET', '/issues/' + self.task)
            if not isinstance(task, dict) or task.get('id') != self.task or task.get('companyId') != self.company or not task.get('projectId'):
                raise Failure('The current task needs an authenticated company/project binding')
            self.project = str(uuid.UUID(task['projectId']))
        return {'agentId': self.agent, 'companyId': self.company, 'runId': self.run, 'projectId': self.project}

    def call(self, name, args):
        if not isinstance(args, dict):
            raise Failure('Tool arguments must be an object')
        if name == 'discover_github_tools':
            if args:
                raise Failure('Discovery accepts no arguments')
            result = self.request('GET', '/plugins/tools')
            if not isinstance(result, list):
                raise Failure('Unexpected plugin tool catalog')
            return {'tools': [t for t in result if isinstance(t, dict) and str(t.get('name', '')).startswith(PREFIX)]}
        if name in READ_TOOLS:
            if args:
                raise Failure('Linked reads accept no target or identity overrides')
            remote, params = READ_TOOLS[name], {'paperclipIssueId': self.task}
        elif name == 'prepare_issue_comment':
            if set(args) != {'repository', 'issueNumber', 'body', 'bodySha256'}:
                raise Failure('Preparation requires only the exact target, body and hash; no identity overrides')
            body = args['body']
            if not isinstance(body, str) or not body.strip() or len(body) > 32768 or hashlib.sha256(body.encode()).hexdigest() != args['bodySha256']:
                raise Failure('The exact body/hash did not match')
            if type(args['issueNumber']) is not int or args['issueNumber'] < 1 or not isinstance(args['repository'], str):
                raise Failure('Invalid GitHub issue target')
            repo = urllib.parse.urlsplit(args['repository'])
            if repo.scheme != 'https' or repo.netloc != 'github.com' or repo.query or repo.fragment or len(repo.path.strip('/').split('/')) != 2:
                raise Failure('Use the canonical https://github.com/owner/repository URL')
            remote = 'add_issue_comment'
            params = {k: args[k] for k in ('repository', 'issueNumber', 'body')}
            params['paperclipIssueId'] = self.task
        else:
            raise Failure('Unknown bridge tool; approval and arbitrary invocation are not exposed')
        return self.request('POST', '/plugins/tools/execute', {'tool': PREFIX + remote, 'parameters': params, 'runContext': self.run_context()})

    def redact(self, result):
        return json.loads(json.dumps(result).replace(self.token, '[REDACTED]'))

def serve(coordinator_id, api_origin, source=sys.stdin, output=sys.stdout):
    client = None
    while True:
        line = source.readline(MAX_MESSAGE + 1)
        if not line:
            return
        if len(line) > MAX_MESSAGE:
            return
        request = {}
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise Failure('Invalid JSON-RPC object')
            if 'id' not in request:
                continue
            method = request.get('method')
            if method == 'initialize':
                result = {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'paperclip-github-broker', 'version': '1.0.0'}}
            elif method == 'ping':
                result = {}
            elif method == 'tools/list':
                result = {'tools': TOOLS}
            elif method == 'tools/call':
                params = request.get('params', {})
                name = params.get('name')
                if name not in {t['name'] for t in TOOLS}:
                    raise Failure('Unknown bridge tool')
                client = client or Client(coordinator_id, api_origin)
                try:
                    value = client.redact(client.call(name, params.get('arguments', {})))
                    result = {'content': [{'type': 'text', 'text': json.dumps(value)}], 'isError': False}
                except Failure as error:
                    result = {'content': [{'type': 'text', 'text': str(error).replace(client.token, '[REDACTED]')}], 'isError': True}
            else:
                raise Failure('Unsupported JSON-RPC method')
            response = {'jsonrpc': '2.0', 'id': request['id'], 'result': result}
        except (Failure, ValueError, TypeError, KeyError, AttributeError):
            response = {'jsonrpc': '2.0', 'id': request.get('id') if isinstance(request, dict) else None, 'error': {'code': -32602, 'message': 'Invalid request or unavailable run-scoped context'}}
        output.write(json.dumps(response) + '\n')
        output.flush()

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--coordinator-id', required=True)
    parser.add_argument('--api-origin', default='http://127.0.0.1:3100')
    cli = parser.parse_args()
    serve(cli.coordinator_id, cli.api_origin)
