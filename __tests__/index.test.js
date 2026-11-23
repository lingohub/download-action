import { jest } from '@jest/globals';
import { strToU8, zipSync } from 'fflate';
import fs from 'fs';
import os from 'os';
import path from 'path';

const core = {
  getInput: jest.fn(),
  setSecret: jest.fn(),
  setOutput: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
  startGroup: jest.fn(),
  endGroup: jest.fn(),
  setFailed: jest.fn()
};

jest.unstable_mockModule('@actions/core', () => core);

const { run } = await import('../src/main.js');

const API = 'https://api.lingohub.com/v2';
const PROJECT_ID = 'pr_0197c8f2-5a6b-7cde-8f12-3456789abcde';
const BRANCH_ID = 'prb_0197c8f2-5a6b-7cde-8f12-3456789abcd1';
const EXPORT_ID = 'rex_0197c8f2-5a6b-7cde-8f12-3456789abcd2';
const DOWNLOAD_URL = 'https://storage.lingohub.com/exports/export.zip?X-Amz-Signature=secret';

function respond(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function exportResult(status, extra = {}) {
  return {
    id: EXPORT_ID,
    object_type: 'EXPORT',
    status,
    status_details: null,
    download_url: status === 'SUCCEEDED' ? DOWNLOAD_URL : null,
    ...extra
  };
}

function zip(files) {
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}

function zipResponse(bytes, init = {}) {
  return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/zip' }, ...init });
}

/** The API answers the project, the export and its status; the download answers `download`. */
function mockApi(download, { status = 'SUCCEEDED', exportExtra = {} } = {}) {
  fetch.mockImplementation(async (url, init) => {
    const href = url.href;
    if (href === `${API}/projects/${PROJECT_ID}`) {
      return respond(200, { id: PROJECT_ID, default_branch_id: BRANCH_ID });
    }
    if (href.startsWith(`${API}/projects/${PROJECT_ID}/branches`)) {
      return respond(200, { data: [{ id: BRANCH_ID, name: 'release' }], has_more: false });
    }
    if (href === `${API}/branches/${BRANCH_ID}/exports` && init.method === 'POST') {
      return respond(202, { data: exportResult('QUEUED'), job_type: 'EXPORT', object_type: 'JOB' });
    }
    if (href === `${API}/exports/${EXPORT_ID}`) {
      return respond(200, exportResult(status, exportExtra));
    }
    if (href === new URL(exportExtra.download_url || DOWNLOAD_URL).href) {
      return download();
    }
    throw new Error(`Unexpected request ${init?.method} ${href}`);
  });
}

function requestTo(urlPrefix) {
  return fetch.mock.calls.find(([url]) => url.href.startsWith(urlPrefix));
}

describe('Lingohub Download Action', () => {
  const originalFetch = globalThis.fetch;
  const sleep = jest.fn(() => Promise.resolve());
  let workspace;
  let inputs;

  beforeEach(() => {
    jest.clearAllMocks();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'download-action-'));
    inputs = { api_key: 'test-api-key', project_id: PROJECT_ID, destination: path.join(workspace, 'repo'), timeout: '300' };
    core.getInput.mockImplementation((name, options) => {
      const value = inputs[name] || '';
      if (options?.required && !value) {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return value;
    });
    globalThis.fetch = jest.fn();
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  function readRepo(file) {
    return fs.readFileSync(path.join(inputs.destination, file), 'utf8');
  }

  test('exports the default branch and unpacks it at the files\' paths', async () => {
    fs.mkdirSync(path.join(inputs.destination, 'locales'), { recursive: true });
    fs.writeFileSync(path.join(inputs.destination, 'locales', 'de.json'), '{"old":true}');
    mockApi(() => zipResponse(zip({
      'locales/de.json': '{"hello":"Hallo"}',
      'locales/fr.json': '{"hello":"Bonjour"}',
      'config/locales/de.yml': 'de:\n  hello: Hallo\n'
    })));

    await run({ sleep });

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(readRepo('locales/de.json')).toBe('{"hello":"Hallo"}');
    expect(readRepo('locales/fr.json')).toBe('{"hello":"Bonjour"}');
    expect(readRepo('config/locales/de.yml')).toBe('de:\n  hello: Hallo\n');
    expect(core.setOutput).toHaveBeenCalledWith('export_id', EXPORT_ID);
    expect(core.setOutput).toHaveBeenCalledWith('file_count', '3');

    const [, create] = requestTo(`${API}/branches/${BRANCH_ID}/exports`);
    expect(create.method).toBe('POST');
    expect(JSON.parse(create.body)).toEqual({ language_codes: null });
    expect(create.headers).toEqual(expect.objectContaining({
      'Authorization': 'Bearer test-api-key',
      'User-Agent': 'lingohub-download-action/1.0.0'
    }));

    const [, download] = requestTo('https://storage.lingohub.com/');
    expect(download.headers).toBeUndefined();
    expect(download.redirect).toBe('manual');
    expect(core.info).not.toHaveBeenCalledWith(expect.stringContaining('X-Amz-Signature'));
  });

  test('exports the named branch in the requested languages', async () => {
    inputs.branch = 'release';
    inputs.language_codes = 'de, fr';
    mockApi(() => zipResponse(zip({ 'de.json': '{}' })));

    await run({ sleep });

    expect(core.setFailed).not.toHaveBeenCalled();
    const [branches] = requestTo(`${API}/projects/${PROJECT_ID}/branches`);
    expect(JSON.parse(branches.searchParams.get('filter'))).toEqual({ where: { _and: [{ 'branch[name]': { _eq: 'release' } }] } });
    const [, create] = requestTo(`${API}/branches/${BRANCH_ID}/exports`);
    expect(JSON.parse(create.body)).toEqual({ language_codes: ['de', 'fr'] });
  });

  test('fails with the export\'s reason and downloads nothing', async () => {
    const details = { code: 'EXPORT_FAILED', detail: 'The file template is invalid.' };
    mockApi(() => zipResponse(zip({})), { status: 'FAILED', exportExtra: { status_details: details } });

    await run({ sleep });

    expect(core.setFailed).toHaveBeenCalledWith(`Export ${EXPORT_ID} ended FAILED (EXPORT_FAILED: The file template is invalid.).`);
    expect(requestTo('https://storage.lingohub.com/')).toBeUndefined();
  });

  test('explains an expired download link', async () => {
    mockApi(() => new Response('<Error>AccessDenied</Error>', { status: 403 }));

    await run({ sleep });

    expect(core.setFailed).toHaveBeenCalledWith(
      'Downloading the export returned HTTP 403; the link may have expired, so run the step again.');
  });

  test('does not follow a redirect from the download link', async () => {
    mockApi(() => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.com/' } }));

    await run({ sleep });

    expect(core.setFailed).toHaveBeenCalledWith('Downloading the export returned HTTP 302.');
    expect(fs.existsSync(inputs.destination)).toBe(false);
  });

  test('refuses a download link that is not https', async () => {
    const insecure = 'http://storage.lingohub.com/exports/export.zip';
    mockApi(() => zipResponse(zip({})), { exportExtra: { download_url: insecure } });

    await run({ sleep });

    expect(core.setFailed).toHaveBeenCalledWith('Refusing to download the export over http: instead of https:.');
    expect(requestTo(insecure)).toBeUndefined();
  });

  test('refuses a download larger than 512 MiB', async () => {
    mockApi(() => zipResponse(zip({}), { headers: { 'Content-Length': String(600 * 1024 * 1024) } }));

    await run({ sleep });

    expect(core.setFailed).toHaveBeenCalledWith('The export is larger than 512 MiB; narrow it with language_codes.');
  });

  test('refuses entries that leave the destination and writes nothing', async () => {
    mockApi(() => zipResponse(zip({ 'locales/de.json': '{}', '../outside.json': '{}' })));

    await run({ sleep });

    expect(core.setFailed).toHaveBeenCalledWith(
      'Refusing to unpack "../outside.json": its path is not a plain relative path.');
    expect(fs.existsSync(path.join(workspace, 'outside.json'))).toBe(false);
    expect(fs.existsSync(path.join(inputs.destination, 'locales', 'de.json'))).toBe(false);
  });

  test('refuses to write through a link that leads outside the destination', async () => {
    const outside = path.join(workspace, 'outside');
    fs.mkdirSync(outside);
    fs.mkdirSync(inputs.destination);
    fs.symlinkSync(outside, path.join(inputs.destination, 'locales'));
    mockApi(() => zipResponse(zip({ 'locales/de.json': '{}' })));

    await run({ sleep });

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringMatching(
      /^Refusing to unpack "locales\/de.json": .* leads outside the destination\.$/));
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  test('writes entries with a leading slash below the destination', async () => {
    mockApi(() => zipResponse(zip({ '/locales/de.json': '{"a":1}' })));

    await run({ sleep });

    expect(core.setFailed).not.toHaveBeenCalled();
    expect(readRepo('locales/de.json')).toBe('{"a":1}');
  });

  test('fails on a download that is not a zip', async () => {
    mockApi(() => zipResponse(strToU8('not a zip')));

    await run({ sleep });

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringMatching(/^The export is not a readable zip: /));
  });

  test('rejects an API V1 project ID before calling the API', async () => {
    inputs.project_id = 'pr_18JCETCbSz7e-40731';

    await run({ sleep });

    expect(core.setFailed).toHaveBeenCalledWith(expect.stringContaining('is an API V1 project ID'));
    expect(fetch).not.toHaveBeenCalled();
  });

  test('handles missing required input', async () => {
    inputs.api_key = '';

    await run({ sleep });

    expect(core.setFailed).toHaveBeenCalledWith('Input required and not supplied: api_key');
  });
});
