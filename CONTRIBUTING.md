# Contributing

Thanks for improving ShareOne for VS Code.

Official site: https://shareone.vip

## Setup

```bash
npm ci
npm run compile
```

## Development

Open this repository in VS Code, press F5, and run the extension in the Extension Development Host.

Use `shareone.baseUrl` only when testing against a local ShareOne environment.

## Before Opening A Pull Request

```bash
npm run compile
npx @vscode/vsce package
```

## Guidelines

- Keep the extension focused on publishing ShareOne links and reviewing comments.
- Do not add background comment polling; comments should refresh manually for the active link.
- Store authorization tokens with VS Code Secret Storage.
- Avoid committing generated `.vsix` packages or local configuration containing API keys.
