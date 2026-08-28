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
npm run package:vsix
```

Install the generated package locally:

```bash
code --install-extension shareone-vscode-0.1.0.vsix
```

## Publish To Visual Studio Marketplace

Create or confirm the publisher at:

```txt
https://marketplace.visualstudio.com/manage
```

Then run:

```bash
npx @vscode/vsce login shareone-vip
npm run publish:marketplace
```

If your publisher ID is not `shareone-vip`, update `publisher` in `package.json` before publishing.

## CI Publishing

GitHub Actions builds a VSIX on every pull request and every push to `main`.

Marketplace publishing only runs when pushing a version tag such as `v0.0.1`.

Before using CI publishing:

1. Create or confirm the `shareone-vip` publisher at:

   ```txt
   https://marketplace.visualstudio.com/manage
   ```

2. Create a Marketplace token with `Marketplace > Manage` scope.

3. Add the token to GitHub:

   ```txt
   Repository Settings > Secrets and variables > Actions > New repository secret
   ```

   Secret name:

   ```txt
   VSCE_PAT
   ```

4. For the first release, push a tag matching the current version:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

5. For later releases, bump the package version and push the generated tag:

   ```bash
   npm version patch
   git push --follow-tags
   ```

Visual Studio Marketplace rejects duplicate versions, so every publish needs a new `package.json` version.

Microsoft plans to retire global Azure DevOps PATs on December 1, 2026. Move this workflow to Microsoft Entra ID secure automated publishing before then.

## Publish To Open VSX

Open VSX helps users on Cursor, VSCodium, Gitpod, Windsurf, and other VS Code-compatible editors find the extension.

```bash
npx ovsx publish shareone-vscode-0.1.0.vsix
```

## Discovery Checklist

- Keep the extension display name clear: ShareOne, publish links, review comments.
- Keep `keywords` focused on real searches: share, publish, link, markdown, pdf, comments, review.
- Put `https://shareone.vip` near the top of README.
- Add screenshots or GIFs before a public launch.
- Add a ShareOne website page linking to the Marketplace listing.
- Publish to both Visual Studio Marketplace and Open VSX.
