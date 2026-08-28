# Publishing ShareOne for VS Code

This project publishes the ShareOne VS Code extension.

Official site: [shareone.vip](https://shareone.vip)

## Prerequisites

- Node.js 22 or newer for the current `@vscode/vsce` release.
- A Microsoft account.
- A Visual Studio Marketplace publisher whose ID matches `publisher` in `package.json`.
- A Marketplace Personal Access Token or trusted publishing setup.

## Local Verification

```bash
npm ci
npm run compile
```

## Package A VSIX

```bash
npx @vscode/vsce package
```

Install the generated package locally:

```bash
code --install-extension shareone-vscode-0.0.1.vsix
```

## Publish To Visual Studio Marketplace

Create or confirm the publisher at:

```txt
https://marketplace.visualstudio.com/manage
```

Then run:

```bash
npx @vscode/vsce login shareone
npx @vscode/vsce publish
```

If your publisher ID is not `shareone`, update `publisher` in `package.json` before publishing.

## Publish To Open VSX

Open VSX helps users on Cursor, VSCodium, Gitpod, Windsurf, and other VS Code-compatible editors find the extension.

```bash
npx ovsx publish shareone-vscode-0.0.1.vsix
```

## Discovery Checklist

- Keep the extension display name clear: ShareOne, publish links, review comments.
- Keep `keywords` focused on real searches: share, publish, link, markdown, pdf, comments, review.
- Put `https://shareone.vip` near the top of README.
- Add screenshots or GIFs before a public launch.
- Add a ShareOne website page linking to the Marketplace listing.
- Publish to both Visual Studio Marketplace and Open VSX.
