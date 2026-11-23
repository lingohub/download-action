# Lingohub Download Action

[![License](https://img.shields.io/github/license/lingohub/download-action?style=flat-square)](./LICENSE)

GitHub Action to download translated files from [Lingohub](https://lingohub.com).

This action downloads the translations of your Lingohub project directly into your GitHub repository, at the paths the files have in Lingohub. A later step can commit them or open a pull request.

## How it works

This action:
1. Starts an export of your Lingohub project branch (the default branch unless you name one)
2. Waits until the export is complete
3. Downloads the exported zip and unpacks it into `destination`, at each file's path in Lingohub, overwriting files that exist

The files' paths in Lingohub are the paths [lingohub/upload-action](https://github.com/lingohub/upload-action) uploaded them from, so with the default `destination` the translations usually land next to their source files.

## Usage

```yaml
name: Download Translations
on:
  workflow_dispatch:
  schedule:
    - cron: '0 0 * * *'  # Run daily at midnight

jobs:
  download:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v5

      - name: Download translations from Lingohub
        uses: lingohub/download-action@v1
        with:
          api_key: ${{ secrets.LINGOHUB_API_KEY }}
          project_id: pr_0197c8f2-5a6b-7cde-8f12-3456789abcde
          language_codes: de,fr

      - name: Commit changes
        uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: Update translations from Lingohub
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `api_key` | Lingohub API key. Store it as a [repository secret](https://docs.github.com/en/actions/security-guides/encrypted-secrets). | Yes | |
| `project_id` | Lingohub project ID, e.g. `pr_0197c8f2-5a6b-7cde-8f12-3456789abcde`. Open the project in Lingohub and choose **Copy ID** from its menu. | Yes | |
| `branch` | Name of the Lingohub project branch to download | No | the project's default branch |
| `language_codes` | Comma-separated language codes to download, e.g. `de,fr` | No | every language of the branch |
| `destination` | Folder the files are written to, at their Lingohub paths. Existing files are overwritten. | No | `.` (the repository root) |
| `timeout` | Seconds to wait for the export | No | `300` |

## Outputs

| Output | Description |
|--------|-------------|
| `export_id` | ID of the export in Lingohub |
| `file_count` | Number of files written |

## Authentication

This action requires an API key from Lingohub. Store your API key as a GitHub secret and reference it in your workflow using `${{ secrets.LINGOHUB_API_KEY }}`. The key is used for Lingohub API calls only.

## Safety

- The export's download link is never written to the log, and the download sends no API key.
- Downloads larger than 512 MiB, or that unpack to more than 1 GiB, are refused; narrow them with `language_codes`.
- Every file is checked before anything is written: no path may leave `destination`, through `..`, an absolute path or a symbolic link.

## Related Actions

- [lingohub/upload-action](https://github.com/lingohub/upload-action): Upload source files to Lingohub

## License

Apache-2.0 © lingohub GmbH
