# ShareOne for VS Code

Publish local files as ShareOne links and review comments without leaving VS Code.

Official site: [shareone.vip](https://shareone.vip)

## What It Does

- Publish HTML, Markdown, TXT, PDF, Word, and PowerPoint files to ShareOne.
- Update an existing HTML, Markdown, or TXT link without changing the URL.
- Configure title, password, watermark, custom slug, and comments before publishing.
- Keep local files bound to their ShareOne links in the current workspace.
- Open published links from the ShareOne Activity Bar.
- Review unresolved comments in a reusable side panel.
- Reply to comments and resolve comments from VS Code.
- Locate text comments in local HTML, Markdown, and TXT source files when possible.

## Quick Start

1. Install the extension.
2. Open a workspace and right-click an HTML, Markdown, TXT, PDF, Word, or PowerPoint file.
3. Run `ShareOne: Publish / Update...`.
4. Authorize ShareOne in the browser when prompted.
5. Copy or open the generated ShareOne link.

The extension stores the authorization token in VS Code Secret Storage. You can still use `ShareOne: Set API Key` for manual development setup.

## Commands

- `ShareOne: Publish / Update...` publishes a new file or shows update actions for an already published file.
- `ShareOne: Publish Current File` publishes quickly with comments enabled for supported text pages.
- `ShareOne: Publish With Options` opens one configuration form for title, password, watermark, custom slug, and comments.
- `ShareOne: Update Existing Share` updates an existing HTML, Markdown, or TXT link in place.
- `ShareOne: Change Share Settings` updates share metadata such as password, watermark, slug, and comments.
- `ShareOne: Open Review Panel` opens comments for the selected ShareOne link.
- `ShareOne: Open Web Manage` opens the ShareOne web management page.
- `ShareOne: Clear API Key` removes the saved local authorization token.

## Link Bindings

ShareOne bindings are stored in the current workspace:

```txt
.shareone/shares.json
```

The binding uses the workspace-relative file path, so it survives VS Code restarts and works across machines when the project path is the same inside the workspace. File content changes do not break the binding.

If you rename or move a file inside VS Code, the extension updates the binding automatically. If you rename it outside VS Code, publish or configure the renamed file again so the workspace can store the new local binding.

## Comment Review

1. Publish an HTML, Markdown, or TXT file with comments enabled.
2. Share the generated link.
3. Open the ShareOne Activity Bar.
4. Click the published link.
5. The ShareOne Review panel opens beside the editor and refreshes comments once for that link.
6. Use `Refresh` in the Review panel to manually reload comments for the active link.
7. Click a text comment card or locate button to jump to the matching local source text.
8. Edit the file manually, update the ShareOne link, then reply or resolve the comment.

The extension does not auto-poll comments and does not refresh all links at once.

## Text And Region Comments

ShareOne supports text selection comments and region comments.

Text selection comments include text anchor data. The extension uses that data to locate the matching source text and highlight it in VS Code when possible.

Region comments are marked as `区域评论` in the Review panel. Clicking a region comment opens the related file but does not select source text, because a region on the rendered page cannot always be mapped back to a specific source text range.

## Markdown Location

Markdown shares are rendered as HTML in the browser, while VS Code edits the original `.md` source. The extension maps common Markdown syntax back to source text, including headings, paragraphs, lists, task lists, blockquotes, emphasis, inline code, links, HTML tags, entities, frontmatter, fenced code blocks, and common inline anchors.

Some cases are still best effort: repeated identical text, complex raw HTML, tables with unusual formatting, Mermaid diagrams rendered as SVG, and source files that changed significantly after publishing.

When the extension cannot locate a comment safely, it keeps focus in ShareOne Review and shows a warning instead of switching to VS Code global Search.

## Settings

- `shareone.baseUrl`: ShareOne API base URL. Default: `https://shareone.vip`.

Use a local URL only when testing against a local ShareOne environment.

## Development

```bash
npm install
npm run compile
```

Open this directory in VS Code, press F5, and run the extension in the Extension Development Host.

## Publishing

See [PUBLISHING.md](./PUBLISHING.md).
