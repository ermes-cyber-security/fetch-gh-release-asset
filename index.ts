import * as core from '@actions/core';
import * as github from '@actions/github';
import type { Context } from '@actions/github/lib/context';
import { EndpointOptions, RequestParameters } from '@octokit/types';
import retry from 'async-retry';
import { mkdir, writeFile } from 'fs/promises';
import fetch, { HeadersInit } from 'node-fetch';
import { dirname } from 'path';
interface GetRepoResult {
  readonly owner: string;
  readonly repo: string;
}

const getRepo = (inputRepoString: string, context: Context): GetRepoResult => {
  if (inputRepoString === '') {
    return { owner: context.repo.owner, repo: context.repo.repo };
  } else {
    const [owner, repo] = inputRepoString.split('/');
    if (typeof owner === 'undefined' || typeof repo === 'undefined')
      throw new Error('Malformed repo');
    return { owner, repo };
  }
};

interface GetReleaseOptions {
  readonly owner: string;
  readonly repo: string;
  readonly version: string;
}

const getRelease = (
  octokit: ReturnType<typeof github.getOctokit>,
  { owner, repo, version }: GetReleaseOptions
) => {
  const tagsMatch = version.match(/^tags\/(.*)$/);
  if (version === 'latest') {
    return octokit.rest.repos.getLatestRelease({ owner, repo });
  } else if (tagsMatch !== null && tagsMatch[1]) {
    return octokit.rest.repos.getReleaseByTag({
      owner,
      repo,
      tag: tagsMatch[1]
    });
  } else {
    return octokit.rest.repos.getRelease({
      owner,
      repo,
      release_id: Math.trunc(Number(version))
    });
  }
};

type GetReleaseResult = ReturnType<typeof getRelease> extends Promise<infer T>
  ? T
  : never;

type Asset = GetReleaseResult['data']['assets'][0];

const createEndpointOptions = (
  octokit: ReturnType<typeof github.getOctokit>,
  endpointUrl: string,
  parameters: RequestParameters
): EndpointOptions => octokit.request.endpoint(endpointUrl, parameters);

const baseFetchFile = async (
  parameters: RequestParameters,
  endpointOptions: EndpointOptions
) => {
  const { body, url, method, headers } = endpointOptions;
  const { token, outputPath } = parameters as {
    token: string;
    outputPath: string;
  };
  const fetchHeaders: HeadersInit = {
    ...(headers || {}),
    authorization: `token ${token}`
  };
  const response = await fetch(url, {
    body,
    headers: fetchHeaders,
    method
  });
  if (!response.ok) {
    const text = await response.text();
    core.warning(text);
    throw new Error('Invalid response');
  }
  const blob = await response.blob();
  const arrayBuffer = await blob.arrayBuffer();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, new Uint8Array(arrayBuffer));
};

const fetchAssetFile = (
  octokit: ReturnType<typeof github.getOctokit>,
  parameters: RequestParameters
) =>
  retry(() => {
    const { owner, repo, id } = parameters;
    const endpoint = createEndpointOptions(
      octokit,
      'GET /repos/:owner/:repo/releases/assets/:asset_id',
      {
        owner,
        repo,
        asset_id: id
      }
    );
    endpoint.headers = endpoint.headers || {};
    endpoint.headers.accept = 'application/octet-stream';
    return (
      baseFetchFile(parameters, endpoint),
      {
        retries: 5,
        minTimeout: 1000
      }
    );
  });

const fetchSourceFile = (url: string, outputPath: string, token: string) =>
  retry(
    () => (
      baseFetchFile(
        {
          token,
          outputPath
        },
        {
          url,
          method: 'GET',
          headers: {
            accept: 'application/vnd.github.v3+json'
          }
        }
      ),
      {
        retries: 5,
        minTimeout: 1000
      }
    )
  );

const printOutput = (release: GetReleaseResult): void => {
  core.setOutput('version', release.data.tag_name);
  core.setOutput('name', release.data.name);
  core.setOutput('body', release.data.body);
};

const filterByFileName = (file: string) => (asset: Asset) =>
  file === asset.name;

const filterByRegex = (file: string) => (asset: Asset) =>
  new RegExp(file).test(asset.name);

const main = async (): Promise<void> => {
  const { owner, repo } = getRepo(
    core.getInput('repo', { required: false }),
    github.context
  );
  const token = core.getInput('token', { required: false });
  const version = core.getInput('version', { required: false }) || 'latest';
  const inputTarget = core.getInput('target', { required: false });
  const file = core.getInput('file', { required: true });
  const usesRegex = core.getBooleanInput('regex', { required: false });
  const onlySourceZip = core.getBooleanInput('only-source-zip', {
    required: false
  });
  const target = inputTarget === '' ? file : inputTarget;
  const baseUrl =
    core.getInput('octokitBaseUrl', { required: false }) || undefined;

  const octokit = github.getOctokit(token, { baseUrl });
  const release = await getRelease(octokit, { owner, repo, version });

  if (onlySourceZip) {
    await fetchSourceFile(
      release.data.zipball_url || '',
      `${target}${file}.zip`,
      token
    );
    printOutput(release);
    return;
  }

  const assetFilterFn = usesRegex
    ? filterByRegex(file)
    : filterByFileName(file);

  const assets = release.data.assets.filter(assetFilterFn);
  if (assets.length === 0) throw new Error('Could not find asset id');
  for (const asset of assets) {
    await fetchAssetFile(octokit, {
      id: asset.id,
      outputPath: usesRegex ? `${target}${asset.name}` : target,
      owner,
      repo,
      token
    });
  }
  printOutput(release);
};

void main();
