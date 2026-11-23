import * as core from '@actions/core';
import { unzipSync } from 'fflate';
import fs from 'fs';
import path from 'path';
import {
  createClient,
  describeStatusDetails,
  LingohubError,
  parseTimeout,
  requireProjectId,
  resolveBranchId,
  waitForJob
} from './lingohub.js';

const USER_AGENT = 'lingohub-download-action/1.0.0';
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 300000;

/** `sleep` and `now` exist for tests; the action itself runs with the defaults. */
export async function run({ sleep, now } = {}) {
  try {
    const apiKey = core.getInput('api_key', { required: true });
    core.setSecret(apiKey);
    const projectId = requireProjectId(core.getInput('project_id', { required: true }).trim());
    const branchName = core.getInput('branch').trim();
    const languageCodes = core.getInput('language_codes').split(/[\s,]+/).filter(Boolean);
    const destination = core.getInput('destination') || '.';
    const timeoutMs = parseTimeout(core.getInput('timeout'));

    const client = createClient({ apiKey, userAgent: USER_AGENT, sleep });
    const branchId = await resolveBranchId(client, projectId, branchName);
    core.info(branchName
      ? `Exporting branch "${branchName}" (${branchId}) of project ${projectId}`
      : `Exporting the default branch (${branchId}) of project ${projectId}`);
    core.info(languageCodes.length > 0 ? `Languages: ${languageCodes.join(', ')}` : 'Languages: all');

    const job = await client.post(`/branches/${branchId}/exports`,
      { language_codes: languageCodes.length > 0 ? languageCodes : null });
    const exportId = job.data.id;
    core.setOutput('export_id', exportId);
    core.info(`Export ${exportId} is ${job.data.status}.`);

    const result = await waitForJob(client, `/exports/${exportId}`, {
      label: `Export ${exportId}`,
      timeoutMs,
      sleep,
      now,
      onStatus: status => core.info(`Export status: ${status}`)
    });
    if (result.status !== 'SUCCEEDED') {
      throw new LingohubError(`Export ${exportId} ended ${result.status} (${describeStatusDetails(result.status_details)}).`);
    }
    if (!result.download_url) {
      throw new LingohubError(`Export ${exportId} succeeded without a download link.`);
    }

    const archive = await download(result.download_url);
    const written = extract(archive, destination);
    core.setOutput('file_count', String(written.length));
    core.info(`Wrote ${written.length} files to ${destination}.`);
  } catch (error) {
    if (!(error instanceof LingohubError) && error.stack) {
      core.debug(error.stack);
    }
    core.setFailed(error.message);
  }
}

/**
 * Fetches the export's zip. The link is presigned, so the request carries no API key; it follows no redirect and the
 * link is never logged, since it grants access for 24 hours.
 */
async function download(downloadUrl) {
  const url = new URL(downloadUrl);
  if (url.protocol !== 'https:') {
    throw new LingohubError(`Refusing to download the export over ${url.protocol} instead of https:.`);
  }
  core.info(`Downloading the export from ${url.host}...`);

  let response;
  try {
    response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (error) {
    throw new LingohubError(`Downloading the export failed: ${error.cause?.message || error.message}`);
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    const expired = [401, 403].includes(response.status) ? '; the link may have expired, so run the step again' : '';
    throw new LingohubError(`Downloading the export returned HTTP ${response.status}${expired}.`);
  }
  if (Number(response.headers.get('Content-Length')) > MAX_DOWNLOAD_BYTES) {
    await response.body?.cancel();
    throw tooLarge();
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_DOWNLOAD_BYTES) {
      throw tooLarge();
    }
    chunks.push(chunk);
  }
  core.info(`Downloaded ${size} bytes.`);
  return new Uint8Array(Buffer.concat(chunks));
}

function tooLarge() {
  return new LingohubError(`The export is larger than ${MAX_DOWNLOAD_BYTES / 1024 / 1024} MiB; `
    + 'narrow it with language_codes.');
}

/**
 * Unpacks the zip into the destination, overwriting files that exist. Every path is checked before anything is
 * written: none may leave the destination, by `..`, an absolute path or a symbolic link.
 */
function extract(archive, destination) {
  let extractedBytes = 0;
  let files;
  try {
    files = unzipSync(archive, {
      filter: file => {
        extractedBytes += file.originalSize;
        if (extractedBytes > MAX_EXTRACTED_BYTES) {
          throw new LingohubError(`The export unpacks to more than ${MAX_EXTRACTED_BYTES / 1024 / 1024} MiB; `
            + 'narrow it with language_codes.');
        }
        return !file.name.endsWith('/');
      }
    });
  } catch (error) {
    if (error instanceof LingohubError) {
      throw error;
    }
    throw new LingohubError(`The export is not a readable zip: ${error.message}`);
  }
  const entries = Object.entries(files).map(([name, data]) => ({ name, segments: entrySegments(name), data }));

  fs.mkdirSync(destination, { recursive: true });
  const root = fs.realpathSync(destination);
  const written = [];
  core.startGroup(`Unpacking ${entries.length} files into ${destination}`);
  try {
    for (const entry of entries) {
      const target = prepareTarget(root, entry);
      fs.writeFileSync(target, entry.data);
      const relative = entry.segments.join('/');
      core.info(`Wrote ${relative}`);
      written.push(relative);
    }
  } finally {
    core.endGroup();
  }
  return written;
}

function entrySegments(name) {
  const relative = name.replace(/^\/+/, '');
  const segments = relative.split('/');
  const unsafe = relative === ''
    || /[\\\0]/.test(relative)
    || /^[A-Za-z]:/.test(relative)
    || segments.some(segment => segment === '' || segment === '.' || segment === '..');
  if (unsafe) {
    throw new LingohubError(`Refusing to unpack "${name}": its path is not a plain relative path.`);
  }
  return segments;
}

/** Creates the entry's folders below root and returns where to write it, refusing links that lead outside root. */
function prepareTarget(root, entry) {
  let current = root;
  for (const segment of entry.segments.slice(0, -1)) {
    current = path.join(current, segment);
    if (lstatOrNull(current)) {
      current = requireInside(root, current, entry.name);
      if (!fs.statSync(current).isDirectory()) {
        throw new LingohubError(`Cannot unpack "${entry.name}": ${current} is not a folder.`);
      }
    } else {
      fs.mkdirSync(current);
    }
  }
  const target = path.join(current, entry.segments.at(-1));
  const existing = lstatOrNull(target);
  if (!existing) {
    return target;
  }
  const resolved = requireInside(root, target, entry.name);
  if (!fs.statSync(resolved).isFile()) {
    throw new LingohubError(`Cannot unpack "${entry.name}": ${target} is not a file.`);
  }
  return resolved;
}

function requireInside(root, candidate, name) {
  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    throw new LingohubError(`Refusing to unpack "${name}": ${candidate} is a link that leads nowhere.`);
  }
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new LingohubError(`Refusing to unpack "${name}": ${candidate} leads outside the destination.`);
  }
  return resolved;
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
